// UploadDropzone.jsx — drag-drop / file-picker upload card. The zone
// itself is pointer-only chrome (role="presentation"); the real
// interactive controls are the file input + buttons inside it.
import { Button } from '../../../../components/ui';
import { AI_KINDS, fmtBytes } from '../documentsShared';

export default function UploadDropzone({
  pendingFile, setPendingFile,
  pendingKind, setPendingKind,
  pendingTitle, setPendingTitle,
  pendingDescription, setPendingDescription,
  uploading,
  draggingOver, setDraggingOver,
  fileInputRef,
  onPickFile, onDrop, onUpload, onUploadAndAnalyse,
}) {
  return (
    <div
      className={`facdoc-dropzone${draggingOver ? ' facdoc-dropzone--active' : ''}`}
      role="presentation"
      onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
      onDragLeave={() => setDraggingOver(false)}
      onDrop={onDrop}
    >
      {!pendingFile ? (
        <div className="facdoc-dropzone-idle">
          <div className="facdoc-dropzone-title">
            Drag &amp; drop a document, or pick a file
          </div>
          <div className="facdoc-dropzone-hint">
            Up to 20 MB · PDFs preferred · the AI analyser uses the file kind you pick
          </div>
          <input ref={fileInputRef} type="file" className="facdoc-file-input"
                 onChange={(e) => onPickFile(e.target.files?.[0])} />
          <Button className="facdoc-btn--choose"
                  onClick={() => fileInputRef.current?.click()}>Choose file</Button>
        </div>
      ) : (
        <div className="facdoc-upload-form">
          <div className="facdoc-upload-fileinfo">
            <div className="facdoc-upload-name">{pendingFile.name}</div>
            <div className="facdoc-upload-meta">
              {fmtBytes(pendingFile.size)} · {pendingFile.type || 'application/octet-stream'}
            </div>
            <button type="button" className="facdoc-linkbtn facdoc-link-remove"
                    onClick={() => setPendingFile(null)}>
              remove
            </button>
          </div>
          <div className="facdoc-upload-fields">
            <div>
              <div className="facdoc-field-label">Document kind</div>
              <select className="fi" value={pendingKind} onChange={(e) => setPendingKind(e.target.value)}>
                {AI_KINDS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </div>
            <div>
              <div className="facdoc-field-label">Title</div>
              <input className="fi" type="text" placeholder="e.g. Final signed slip"
                     value={pendingTitle} onChange={(e) => setPendingTitle(e.target.value)} />
            </div>
            <div>
              <div className="facdoc-field-label">Description (optional)</div>
              <input className="fi" type="text" placeholder="Notes…"
                     value={pendingDescription} onChange={(e) => setPendingDescription(e.target.value)} />
            </div>
          </div>
          <div className="facdoc-upload-actions">
            <Button className="facdoc-btn--choose" disabled={uploading}
                    onClick={onUpload}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
            <Button variant="primary" className="facdoc-btn--upload" disabled={uploading}
                    onClick={onUploadAndAnalyse}>
              {uploading ? 'Uploading…' : 'Upload & analyse'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
