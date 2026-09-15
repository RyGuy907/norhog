#!/usr/bin/env bash
#
# Manual deploy over SSH. Builds the frontend, bundles it with the service, and
# restarts it on the server with pm2. The CI pipeline uses deployFromS3.sh
# instead; this script is for first-time setup or deploying without CI.
#
#   ./deployService.sh -k <pem key file> -h <hostname> -s <service>

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
npm install # vite is needed to bundle the frontend
npm run build
cp -rf dist build/public # the built frontend is served by the service as static files
cp service/*.js build
# Only the package manifests are copied. dbConfig.json holds the Atlas
# credentials and stays on the server (see step 4), so a deploy never carries
# them off this machine.
cp service/package.json service/package-lock.json build
rm -f build/*.test.js build/vitest.config.js # tests aren't needed on the server

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
# Production install only. Skipping vitest and supertest roughly halves the
# install's memory peak and disk use.
npm ci --omit=dev
pm2 restart ${service}

# pm2 reporting "online" only means the process is alive, not that it opened the
# port. If startup fails before app.listen, pm2 still looks fine while Caddy
# returns 502, so the deploy checks the port directly.
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
