import { FormEvent, useEffect, useMemo, useState } from 'react';

const ASSEMBLY_KEY_STORAGE = 'transcript-ai-assembly-key';
const GOOGLE_KEY_STORAGE = 'transcript-ai-google-key';

type CleanupMode = 'orthography' | 'grammar';

type Correction = {
  before: string;
  after: string;
  reason: string;
  timestamp?: number | null;
};

type ApiResponse = {
  rawText: string;
  cleanedText: string;
  corrections: Correction[];
  downloads: {
    txt: string;
    srt?: string | null;
    vtt?: string | null;
  };
};

const defaultCorrections: Correction[] = [];

function loadStoredKey(key: string): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(key) ?? '';
}

function SettingsModal({
  open,
  onClose,
  assemblyKey,
  googleKey,
  onSave
}: {
  open: boolean;
  onClose: () => void;
  assemblyKey: string;
  googleKey: string;
  onSave: (keys: { assembly: string; google: string }) => void;
}) {
  const [localAssemblyKey, setLocalAssemblyKey] = useState(assemblyKey);
  const [localGoogleKey, setLocalGoogleKey] = useState(googleKey);

  useEffect(() => {
    setLocalAssemblyKey(assemblyKey);
  }, [assemblyKey]);

  useEffect(() => {
    setLocalGoogleKey(googleKey);
  }, [googleKey]);

  if (!open) {
    return null;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ assembly: localAssemblyKey.trim(), google: localGoogleKey.trim() });
    onClose();
  };

  const handleClear = () => {
    setLocalAssemblyKey('');
    setLocalGoogleKey('');
    onSave({ assembly: '', google: '' });
    onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={handleSubmit}>
        <h2>API Settings</h2>
        <p className="modal-subtitle">
          Provide your AssemblyAI and Google AI Studio keys. These will be stored locally in your browser only.
        </p>
        <label>
          AssemblyAI API key
          <input
            type="password"
            value={localAssemblyKey}
            placeholder="assemblyai-..."
            onChange={(event) => setLocalAssemblyKey(event.target.value)}
          />
        </label>
        <label>
          Google AI API key
          <input
            type="password"
            value={localGoogleKey}
            placeholder="AIza..."
            onChange={(event) => setLocalGoogleKey(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={handleClear}>
            Clear keys
          </button>
          <div className="modal-buttons">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function CorrectionsTable({ corrections }: { corrections: Correction[] }) {
  if (!corrections.length) {
    return (
      <div className="empty-corrections">No corrections were required 🎉</div>
    );
  }

  return (
    <table className="corrections">
      <thead>
        <tr>
          <th>Before</th>
          <th>After</th>
          <th>Reason</th>
          <th>Timestamp</th>
        </tr>
      </thead>
      <tbody>
        {corrections.map((entry, index) => (
          <tr key={`${entry.before}-${entry.after}-${index}`}>
            <td>{entry.before}</td>
            <td>{entry.after}</td>
            <td>{entry.reason}</td>
            <td>{
              entry.timestamp != null && !Number.isNaN(entry.timestamp)
                ? formatTimestamp(entry.timestamp)
                : '—'
            }</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatTimestamp(seconds: number) {
  const date = new Date(seconds * 1000);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return hh !== '00' ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function DownloadButtons({ downloads }: { downloads: ApiResponse['downloads'] }) {
  const handleDownload = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="download-buttons">
      <button
        type="button"
        className="secondary"
        onClick={() => handleDownload(downloads.txt, 'transcript.txt', 'text/plain')}
      >
        Download .txt
      </button>
      {downloads.srt ? (
        <button
          type="button"
          className="secondary"
          onClick={() => handleDownload(downloads.srt!, 'transcript.srt', 'text/plain')}
        >
          Download .srt
        </button>
      ) : null}
      {downloads.vtt ? (
        <button
          type="button"
          className="secondary"
          onClick={() => handleDownload(downloads.vtt!, 'transcript.vtt', 'text/vtt')}
        >
          Download .vtt
        </button>
      ) : null}
    </div>
  );
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [assemblyKey, setAssemblyKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [activeTab, setActiveTab] = useState<'paste' | 'upload' | 'youtube'>('paste');
  const [cleanupMode, setCleanupMode] = useState<CleanupMode>('grammar');
  const [pasteValue, setPasteValue] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);

  useEffect(() => {
    try {
      const storedAssembly = loadStoredKey(ASSEMBLY_KEY_STORAGE);
      const storedGoogle = loadStoredKey(GOOGLE_KEY_STORAGE);
      setAssemblyKey(storedAssembly);
      setGoogleKey(storedGoogle);
    } catch (storageError) {
      console.warn('Unable to read stored keys', storageError);
    }
  }, []);

  const hasKeys = useMemo(() => Boolean(assemblyKey && googleKey), [assemblyKey, googleKey]);

  const persistKeys = (assembly: string, google: string) => {
    localStorage.setItem(ASSEMBLY_KEY_STORAGE, assembly);
    localStorage.setItem(GOOGLE_KEY_STORAGE, google);
    setAssemblyKey(assembly);
    setGoogleKey(google);
  };

  const ensureKeys = () => {
    if (!assemblyKey || !googleKey) {
      setError('Please add your AssemblyAI and Google API keys in Settings.');
      setShowSettings(true);
      return false;
    }
    return true;
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      setError('Unable to copy to clipboard.');
    });
  };

  const callCleanup = async (endpoint: string, options: RequestInit) => {
    const response = await fetch(endpoint, options);
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return (await response.json()) as ApiResponse;
  };

  const handlePasteCleanup = async (event: FormEvent) => {
    event.preventDefault();
    if (!ensureKeys()) return;
    if (!pasteValue.trim()) {
      setError('Please add some transcript text to clean.');
      return;
    }
    setIsProcessing(true);
    setError(null);

    try {
      const data = await callCleanup('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: pasteValue,
          cleanupMode,
          assemblyKey,
          googleKey
        })
      });
      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Unexpected error cleaning transcript.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!ensureKeys()) return;
    if (!selectedFile) {
      setError('Please select a media file to upload.');
      return;
    }
    const formData = new FormData();
    formData.append('media', selectedFile);
    formData.append('cleanupMode', cleanupMode);
    formData.append('assemblyKey', assemblyKey);
    formData.append('googleKey', googleKey);

    setIsProcessing(true);
    setError(null);

    try {
      const response = await fetch('/api/transcribe/upload', {
        method: 'POST',
        body: formData
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = (await response.json()) as ApiResponse;
      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Unexpected error during transcription.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleYoutubeSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ensureKeys()) return;
    if (!youtubeUrl.trim()) {
      setError('Please enter a YouTube URL to transcribe.');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const data = await callCleanup('/api/transcribe/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: youtubeUrl,
          cleanupMode,
          assemblyKey,
          googleKey
        })
      });
      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Unexpected error processing YouTube URL.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="app">
      <header>
        <div>
          <h1>Transcript AI Codex</h1>
          <p className="tagline">Transcribe, clean, and export transcripts with AssemblyAI + Gemini 2.5 Pro.</p>
        </div>
        <button type="button" className="secondary" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      <section className="card">
        <div className="mode-toggle" role="radiogroup" aria-label="Cleanup mode">
          <label className={cleanupMode === 'orthography' ? 'selected' : ''}>
            <input
              type="radio"
              name="cleanupMode"
              value="orthography"
              checked={cleanupMode === 'orthography'}
              onChange={() => setCleanupMode('orthography')}
            />
            Orthography only
          </label>
          <label className={cleanupMode === 'grammar' ? 'selected' : ''}>
            <input
              type="radio"
              name="cleanupMode"
              value="grammar"
              checked={cleanupMode === 'grammar'}
              onChange={() => setCleanupMode('grammar')}
            />
            Orthography + light grammar
          </label>
        </div>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'paste'}
            className={activeTab === 'paste' ? 'active' : ''}
            onClick={() => setActiveTab('paste')}
          >
            Paste transcript
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'upload'}
            className={activeTab === 'upload' ? 'active' : ''}
            onClick={() => setActiveTab('upload')}
          >
            Upload media
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'youtube'}
            className={activeTab === 'youtube' ? 'active' : ''}
            onClick={() => setActiveTab('youtube')}
          >
            YouTube URL
          </button>
        </div>

        <div className="tab-panels">
          {activeTab === 'paste' ? (
            <form onSubmit={handlePasteCleanup} className="tab-panel">
              <label className="stack">
                Paste transcript text
                <textarea
                  rows={10}
                  value={pasteValue}
                  onChange={(event) => setPasteValue(event.target.value)}
                  placeholder="Drop in the transcript you want cleaned..."
                />
              </label>
              <div className="actions">
                <button type="submit" className="primary" disabled={isProcessing}>
                  {isProcessing ? 'Cleaning…' : 'Clean it up'}
                </button>
              </div>
            </form>
          ) : null}

          {activeTab === 'upload' ? (
            <form onSubmit={handleFileUpload} className="tab-panel">
              <label className="stack">
                Choose an audio or video file (.mp3, .wav, .mp4)
                <input
                  type="file"
                  accept=".mp3,.wav,.mp4,video/mp4,audio/mpeg,audio/wav"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
                {selectedFile ? <span className="file-name">Selected: {selectedFile.name}</span> : null}
              </label>
              <div className="actions">
                <button type="submit" className="primary" disabled={isProcessing}>
                  {isProcessing ? 'Transcribing…' : 'Transcribe + clean'}
                </button>
              </div>
            </form>
          ) : null}

          {activeTab === 'youtube' ? (
            <form onSubmit={handleYoutubeSubmit} className="tab-panel">
              <label className="stack">
                YouTube URL
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={(event) => setYoutubeUrl(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                />
              </label>
              <div className="actions">
                <button type="submit" className="primary" disabled={isProcessing}>
                  {isProcessing ? 'Transcribing…' : 'Transcribe + clean'}
                </button>
              </div>
            </form>
          ) : null}
        </div>
        {!hasKeys ? (
          <div className="hint">You&apos;ll need to add your API keys in Settings before processing transcripts.</div>
        ) : null}
      </section>

      {error ? <div className="error">{error}</div> : null}

      {result ? (
        <section className="results">
          <div className="transcripts">
            <div className="transcript-card">
              <div className="transcript-header">
                <h2>Raw transcript</h2>
                <button type="button" className="ghost" onClick={() => handleCopy(result.rawText)}>
                  Copy
                </button>
              </div>
              <pre className="transcript-body">{result.rawText}</pre>
            </div>
            <div className="transcript-card">
              <div className="transcript-header">
                <h2>Cleaned transcript</h2>
                <div className="transcript-actions">
                  <button type="button" className="ghost" onClick={() => handleCopy(result.cleanedText)}>
                    Copy
                  </button>
                </div>
              </div>
              <pre className="transcript-body">{result.cleanedText}</pre>
            </div>
          </div>
          <DownloadButtons downloads={result.downloads} />
          <div className="corrections-card">
            <h2>Corrections</h2>
            <CorrectionsTable corrections={result.corrections ?? defaultCorrections} />
          </div>
        </section>
      ) : null}

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        assemblyKey={assemblyKey}
        googleKey={googleKey}
        onSave={({ assembly, google }) => persistKeys(assembly, google)}
      />
    </div>
  );
}
