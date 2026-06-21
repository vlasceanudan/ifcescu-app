import { useRef } from "react";
import { useI18n } from "../i18n/react";
// Inlined so the "building" letters (fill:currentColor) follow the theme color.
import logoRaw from "../../public/logo_bsro.svg?raw";

interface Props {
  onFile: (file: File) => void;
  variant?: "drop" | "button";
}

export function UploadPanel({ onFile, variant = "drop" }: Props) {
  const { t } = useI18n();
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
        <button className="toggle" onClick={() => inputRef.current?.click()} title={t("upload.changeTitle")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -3 }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          {t("upload.change")}
        </button>
        {input}
      </>
    );
  }

  return (
    <div className="upload-card">
      <div className="upload-logo" dangerouslySetInnerHTML={{ __html: logoRaw }} />
      <h2>IFCescu</h2>
      <p className="upload-sub">{t("upload.sub")}</p>
      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files);
        }}
      >
        {t("upload.dropPre")}<strong>.ifc</strong>{t("upload.dropPost")}
      </div>
      <div className="upload-credit">
        <span>
          {t("upload.creditBuilt")}{" "}
          <a href="https://github.com/LTplus-AG/ifc-lite" target="_blank" rel="noreferrer">ifc-lite</a>.
        </span>
        <span>
          {t("upload.creditThanks")}{" "}
          <a href="https://buymeacoffee.com/louistrue" target="_blank" rel="noreferrer">{t("upload.creditSupport")}</a>.
        </span>
      </div>
      {input}
    </div>
  );
}
