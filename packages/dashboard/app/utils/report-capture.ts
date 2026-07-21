const MAX_ACTIVITY = 20;
const activity: string[] = [];

/**
 * FNXC:ReportPipeline 2026-07-19-10:00:
 * Capture returns a local PNG blob solely for immediate artifact upload. The
 * caller must not serialize it into a report payload or display it as a draft.
 */
export async function captureScreenshot(): Promise<Blob | undefined> {
  if (!navigator.mediaDevices?.getDisplayMedia) return undefined;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video"); video.srcObject = stream; await video.play();
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), "image/png"));
  } catch { return undefined; } finally { stream?.getTracks().forEach((track) => track.stop()); }
}
export function recordActivity(label: string): void { activity.push(label.slice(0, 80)); while (activity.length > MAX_ACTIVITY) activity.shift(); }
export function getRecentActivity(): string[] { return [...activity]; }
export function clearReportActivityForTests(): void { activity.length = 0; }
