import { useRef } from "react";

interface Props {
  onFile: (file: File) => void;
  variant?: "drop" | "button";
}

export function UploadPanel({ onFile, variant = "drop" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".ifc"
      data-testid="ifc-input"
      style={{ display: "none" }}
      onChange={(e) => pick(e.target.files)}
    />
  );

  if (variant === "button") {
    return (
      <>
        <button className="toggle" onClick={() => inputRef.current?.click()} title="Încarcă alt fișier IFC">
          📁 Schimbă fișier
        </button>
        {input}
      </>
    );
  }

  return (
    <div className="upload-card">
      <div className="upload-icon">🧊</div>
      <h2>Plan de situație IFC</h2>
      <p className="upload-sub">Încărcați un fișier IFC pentru a edita datele și a-l vizualiza în 3D.</p>
      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files);
        }}
      >
        Trageți un fișier <strong>.ifc</strong> aici sau faceți click pentru a selecta
      </div>
      {input}
    </div>
  );
}
