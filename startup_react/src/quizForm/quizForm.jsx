import { useState } from 'react';
import './quizForm.css';

const emptyEntry = () => ({ question: '', answer: '', acceptText: '' });

// Server entries store accept as an array; the form edits it as one
// comma-separated text field.
const toFormDifficulties = (difficulties) => {
  const out = {};
  for (const level of ['easy', 'medium', 'hard']) {
    out[level] = (difficulties?.[level] || [emptyEntry()]).map((entry) => ({
      question: entry.question || '',
      answer: entry.answer || '',
      acceptText: entry.acceptText ?? (entry.accept || []).join(', '),
    }));
  }
  return out;
};

const toPayloadDifficulties = (difficulties) => {
  const out = {};
  for (const level of ['easy', 'medium', 'hard']) {
    out[level] = difficulties[level].map((entry) => ({
      question: entry.question,
      answer: entry.answer,
      accept: entry.acceptText.split(',').map((text) => text.trim()).filter(Boolean),
    }));
  }
  return out;
};

// eslint-disable-next-line react-refresh/only-export-components
export const emptyQuizForm = () => ({
  slug: '',
  title: '',
  image: '',
  description: '',
  instructions: '',
  timeLimits: { easy: 300, medium: 480, hard: 600 },
  difficulties: {
    easy: [emptyEntry()],
    medium: [emptyEntry()],
    hard: [emptyEntry()],
  },
});

// Shared quiz editor used by the admin quiz manager and the public
// suggestion form. Image file upload (S3) is admin-only via allowUpload.
export function QuizForm({ initial, slugLocked, allowUpload, submitLabel, errorMsg, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    ...initial,
    timeLimits: { easy: 300, medium: 480, hard: 600, ...initial.timeLimits },
    difficulties: toFormDifficulties(initial.difficulties),
  }));
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const setField = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const setEntry = (level, index, field, value) => {
    setForm((prev) => {
      const entries = prev.difficulties[level].map((entry, i) =>
        i === index ? { ...entry, [field]: value } : entry
      );
      return { ...prev, difficulties: { ...prev.difficulties, [level]: entries } };
    });
  };

  const addEntry = (level) => {
    setForm((prev) => ({
      ...prev,
      difficulties: { ...prev.difficulties, [level]: [...prev.difficulties[level], emptyEntry()] },
    }));
  };

  const removeEntry = (level, index) => {
    setForm((prev) => ({
      ...prev,
      difficulties: {
        ...prev.difficulties,
        [level]: prev.difficulties[level].filter((_, i) => i !== index),
      },
    }));
  };

  const uploadImage = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const response = await fetch('/api/quiz-image-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setUploadError(data?.msg || 'Image upload is unavailable');
        return;
      }
      const { uploadUrl, publicUrl } = await response.json();
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (putResponse.ok) {
        setField('image', publicUrl);
      } else {
        setUploadError('Upload to storage failed');
      }
    } catch (error) {
      console.error('Image upload failed:', error);
      setUploadError('Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="quiz-form">
      {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}

      <div className="mb-3">
        <label className="form-label" htmlFor="quiz-slug">Slug (URL name, e.g. french-revolution)</label>
        <input
          id="quiz-slug"
          className="form-control"
          value={form.slug}
          disabled={slugLocked}
          onChange={(e) => setField('slug', e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="quiz-title">Title</label>
        <input
          id="quiz-title"
          className="form-control"
          value={form.title}
          onChange={(e) => setField('title', e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="quiz-description">Description</label>
        <textarea
          id="quiz-description"
          className="form-control"
          value={form.description}
          onChange={(e) => setField('description', e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="quiz-instructions">Instructions</label>
        <textarea
          id="quiz-instructions"
          className="form-control"
          value={form.instructions}
          onChange={(e) => setField('instructions', e.target.value)}
        />
      </div>
      <div className="mb-3">
        <span className="form-label d-block">Time limits in seconds (easy / medium / hard)</span>
        <div className="time-limit-row">
          {['easy', 'medium', 'hard'].map((level) => (
            <input
              key={level}
              type="number"
              className="form-control time-limit"
              aria-label={`${level} time limit`}
              value={form.timeLimits[level]}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  timeLimits: { ...prev.timeLimits, [level]: e.target.value },
                }))
              }
            />
          ))}
        </div>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="quiz-image-input">
          {allowUpload ? 'Image (upload a file or paste a URL)' : 'Image URL (optional)'}
        </label>
        {allowUpload && (
          <input
            id="quiz-image-file"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="form-control"
            onChange={(e) => uploadImage(e.target.files[0])}
          />
        )}
        {uploading && <p>Uploading...</p>}
        {uploadError && <p className="text-danger">{uploadError}</p>}
        <input
          id="quiz-image-input"
          className="form-control mt-2"
          placeholder="https://..."
          value={form.image}
          onChange={(e) => setField('image', e.target.value)}
        />
        {form.image && <img src={form.image} alt="Quiz preview" className="image-preview" />}
      </div>

      {['easy', 'medium', 'hard'].map((level) => (
        <fieldset className="difficulty-editor" key={level}>
          <legend className="text-capitalize">{level} questions</legend>
          {form.difficulties[level].map((entry, index) => (
            <div className="question-row" key={index}>
              <input
                className="form-control"
                placeholder="Question"
                value={entry.question}
                onChange={(e) => setEntry(level, index, 'question', e.target.value)}
              />
              <input
                className="form-control"
                placeholder="Answer"
                value={entry.answer}
                onChange={(e) => setEntry(level, index, 'answer', e.target.value)}
              />
              <input
                className="form-control"
                placeholder="Also accept (optional, comma-separated)"
                value={entry.acceptText}
                onChange={(e) => setEntry(level, index, 'acceptText', e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={() => removeEntry(level, index)}
                disabled={form.difficulties[level].length === 1}
              >
                &times;
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => addEntry(level)}>
            Add question
          </button>
        </fieldset>
      ))}

      <div className="mb-5">
        <button
          className="btn btn-primary me-2"
          onClick={() =>
            onSave({
              ...form,
              timeLimits: {
                easy: parseInt(form.timeLimits.easy, 10),
                medium: parseInt(form.timeLimits.medium, 10),
                hard: parseInt(form.timeLimits.hard, 10),
              },
              difficulties: toPayloadDifficulties(form.difficulties),
            })
          }
          disabled={uploading}
        >
          {submitLabel}
        </button>
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
