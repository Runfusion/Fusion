import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingWindow } from "./FloatingWindow";
import "./PendingAttachmentPreviews.css";

export interface PendingAttachmentPreviewItem {
  file: File;
  /** Present only for images, which can be opened in the floating image viewer. */
  previewUrl?: string;
}

interface PendingAttachmentPreviewsProps {
  attachments: PendingAttachmentPreviewItem[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  removeLabel: string;
  testIdPrefix: string;
}

/*
FNXC:QuickAddAttachments 2026-08-03-00:00:
Task creation surfaces share one pending-attachment renderer so photos retain the established
floating preview while non-image task-store attachments have only an actionable filename and
remove control. Never render an image-open button without a preview URL.
*/
export function PendingAttachmentPreviews({
  attachments,
  onRemove,
  disabled = false,
  removeLabel,
  testIdPrefix,
}: PendingAttachmentPreviewsProps) {
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const selectedImage = selectedPreviewUrl
    ? attachments.find((attachment) => attachment.previewUrl === selectedPreviewUrl) ?? null
    : null;

  const closePreview = useCallback((restoreFocus = true) => {
    const buttonToFocus = returnFocusRef.current;
    setSelectedPreviewUrl(null);
    returnFocusRef.current = null;
    if (restoreFocus) {
      requestAnimationFrame(() => buttonToFocus?.focus());
    }
  }, []);

  useEffect(() => {
    if (!selectedImage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePreview, selectedImage]);

  const openPreview = useCallback((previewUrl: string, button: HTMLButtonElement) => {
    returnFocusRef.current = button;
    setSelectedPreviewUrl(previewUrl);
  }, []);

  const handleRemove = useCallback((index: number, previewUrl?: string) => {
    if (previewUrl && selectedPreviewUrl === previewUrl) {
      closePreview(false);
    }
    onRemove(index);
  }, [closePreview, onRemove, selectedPreviewUrl]);

  if (attachments.length === 0) return null;

  return (
    <>
      <div className="inline-create-previews">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.previewUrl || `${attachment.file.name}-${index}`}
            className={`inline-create-preview${attachment.previewUrl ? "" : " inline-create-preview--file"}`}
          >
            {attachment.previewUrl ? (
              <button
                type="button"
                className="pending-image-preview__open"
                onClick={(event) => openPreview(attachment.previewUrl!, event.currentTarget)}
                aria-label={`Open image ${attachment.file.name}`}
                data-testid={`${testIdPrefix}-open-${index}`}
              >
                <img src={attachment.previewUrl} alt="" />
              </button>
            ) : (
              <span className="pending-attachment-preview__file" data-testid={`${testIdPrefix}-file-${index}`}>
                {attachment.file.name}
              </span>
            )}
            <button
              type="button"
              className="inline-create-preview-remove"
              onClick={(event) => {
                event.stopPropagation();
                handleRemove(index, attachment.previewUrl);
              }}
              disabled={disabled}
              title={removeLabel}
              aria-label={`${removeLabel}: ${attachment.file.name}`}
              data-testid={`${testIdPrefix}-remove-${index}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {selectedImage?.previewUrl && (
        <FloatingWindow
          title={selectedImage.file.name}
          onClose={closePreview}
          windowKey="pending-image-preview"
          defaultSize={{ width: 640, height: 480 }}
          minSize={{ width: 320, height: 240 }}
          className="floating-window--image-preview"
          suspendGeometryPersistenceOnMobile
          ariaLabel={`Image preview: ${selectedImage.file.name}`}
        >
          <div className="pending-image-preview__modal-content">
            <img src={selectedImage.previewUrl} alt={selectedImage.file.name} />
          </div>
        </FloatingWindow>
      )}
    </>
  );
}
