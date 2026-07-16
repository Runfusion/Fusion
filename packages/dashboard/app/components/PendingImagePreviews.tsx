import { useCallback, useEffect, useRef, useState } from "react";
import { FloatingWindow } from "./FloatingWindow";
import "./PendingImagePreviews.css";

export interface PendingImagePreviewItem {
  file: File;
  previewUrl: string;
}

interface PendingImagePreviewsProps {
  images: PendingImagePreviewItem[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  removeLabel: string;
  testIdPrefix: string;
}

/*
FNXC:QuickAddAttachments 2026-07-16-00:00:
QuickEntryBox, TaskForm, and InlineCreateCard must expose identical pending-image open and remove controls. Keeping the floating preview here prevents keyboard dismissal, focus restoration, and blob-URL removal behavior from drifting between task-creation surfaces.
*/
export function PendingImagePreviews({
  images,
  onRemove,
  disabled = false,
  removeLabel,
  testIdPrefix,
}: PendingImagePreviewsProps) {
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const selectedImage = selectedPreviewUrl
    ? images.find((image) => image.previewUrl === selectedPreviewUrl) ?? null
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

  const handleRemove = useCallback((index: number, previewUrl: string) => {
    if (selectedPreviewUrl === previewUrl) {
      closePreview(false);
    }
    onRemove(index);
  }, [closePreview, onRemove, selectedPreviewUrl]);

  if (images.length === 0) return null;

  return (
    <>
      <div className="inline-create-previews">
        {images.map((image, index) => (
          <div key={image.previewUrl} className="inline-create-preview">
            <button
              type="button"
              className="pending-image-preview__open"
              onClick={(event) => openPreview(image.previewUrl, event.currentTarget)}
              aria-label={`Open image ${image.file.name}`}
              data-testid={`${testIdPrefix}-open-${index}`}
            >
              <img src={image.previewUrl} alt="" />
            </button>
            <button
              type="button"
              className="inline-create-preview-remove"
              onClick={(event) => {
                event.stopPropagation();
                handleRemove(index, image.previewUrl);
              }}
              disabled={disabled}
              title={removeLabel}
              aria-label={removeLabel}
              data-testid={`${testIdPrefix}-remove-${index}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {selectedImage && (
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
