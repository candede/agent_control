export function downloadFile(filename: string, blob: Blob) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    // Let activation finish before releasing resources, including on failure.
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 0);
  }
}
