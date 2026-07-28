while getopts k:h:s: flag
do
    case "${flag}" in
        k) key=${OPTARG};;
        h) hostname=${OPTARG};;
        s) service=${OPTARG};;
    esac
done

if [[ -z "$key" || -z "$hostname" || -z "$service" ]]; then
    printf "\nMissing required parameter.\n"
    printf "  syntax: deployService.sh -k <pem key file> -h <hostname> -s <service>\n\n"
    exit 1
fi

printf "\n----> Deploying React bundle $service to $hostname with $key\n"

# Step 1
printf "\n----> Build the distribution package\n"
rm -rf build
mkdir build
npm install # make sure vite is installed so that we can bundle
npm run build # build the React front end
cp -rf dist build/public # move the React front end to the target distribution
cp service/*.js build # move the back end service to the target distribution
# Only the package manifests ship. dbConfig.json holds the Atlas credentials and
# lives on the server instead (see step 4), so a deploy never carries secrets off
# this machine and CI can run the same script without them.
cp service/package.json service/package-lock.json build
rm -f build/*.test.js build/vitest.config.js # tests don't belong in the deployed bundle

# Step 2
printf "\n----> Clearing out previous distribution on the target\n"
ssh -i "$key" ubuntu@$hostname << ENDSSH
rm -rf services/${service}
mkdir -p services/${service}
ENDSSH

# Step 3
printf "\n----> Copy the distribution package to the target\n"
scp -r -i "$key" build/* ubuntu@$hostname:services/$service

# Step 4
printf "\n----> Deploy the service on the target\n"
ssh -i "$key" ubuntu@$hostname << ENDSSH
bash -i
# Step 2 wipes services/${service}, so the real credentials live outside that
# directory and are linked back in on every deploy. Create the file once:
#   mkdir -p ~/config/${service}
#   nano ~/config/${service}/dbConfig.json
#   chmod 600 ~/config/${service}/dbConfig.json
if [ ! -f ~/config/${service}/dbConfig.json ]; then
  printf "\n!!!! Missing ~/config/${service}/dbConfig.json on the server.\n"
  printf "     Create it there once (chmod 600), then re-run this script.\n\n"
  exit 1
fi
ln -sf ~/config/${service}/dbConfig.json services/${service}/dbConfig.json
cd services/${service}
# Production install only: vitest and supertest have no business on the server,
# and skipping them roughly halves both the install peak and the disk footprint.
npm ci --omit=dev
pm2 restart ${service}

# Smoke check: pm2 reporting "online" only means the process is alive, not that it
# ever bound the port. A boot path that dies before app.listen leaves pm2 green
# while every request through Caddy returns 502. Fail the deploy loudly instead.
sleep 6
if curl -fsS -m 10 -o /dev/null http://127.0.0.1:4000/api/quizzes; then
  printf "\n----> Smoke check passed: service is answering on port 4000\n"
else
  printf "\n!!!! DEPLOY FAILED: nothing is answering on port 4000.\n"
  printf "     pm2 may still report the process as online. Check:\n"
  printf "       pm2 logs %s --lines 30\n" "${service}"
  exit 1
fi
ENDSSH

# Step 5
printf "\n----> Removing local copy of the distribution package\n"
rm -rf build
rm -rf dist