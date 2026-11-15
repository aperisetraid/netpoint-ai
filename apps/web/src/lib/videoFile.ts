const maximumVideoSizeBytes = 1024 * 1024 * 1024
const allowedExtensions = ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm']

export const videoAcceptAttribute =
  'video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska,.m4v,.mkv'

/** Returns a user-facing error, or null when the file can be analysed. */
export function validateVideoFile(file: File): string | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (!allowedExtensions.includes(extension ?? '')) {
    return 'Formato no compatible. Selecciona MP4, M4V, MOV, AVI, MKV o WebM.'
  }
  if (file.size > maximumVideoSizeBytes) return 'El archivo supera el límite de 1 GB.'
  return null
}
