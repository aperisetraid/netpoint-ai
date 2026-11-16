import { useEffect, useRef, useState } from 'react'
import { Video, X } from 'lucide-react'

export interface PlayerNames {
  far: string
  near: string
}

interface PlayerNamesDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: (names: PlayerNames) => void
}

/** Modal that asks who plays on each side before an analysis starts. */
export function PlayerNamesDialog({ open, onCancel, onConfirm }: PlayerNamesDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [names, setNames] = useState<PlayerNames>({ far: '', near: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = { far: names.far.trim(), near: names.near.trim() }
    if (!trimmed.far || !trimmed.near) {
      setError('Escribe el nombre de ambos jugadores.')
      return
    }
    setNames(trimmed)
    setError('')
    onConfirm(trimmed)
  }

  return (
    <dialog
      ref={dialogRef}
      className="player-dialog"
      aria-labelledby="player-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form className="player-dialog__form" onSubmit={handleSubmit}>
        <div className="player-dialog__header">
          <h2 id="player-dialog-title">¿Quién juega en cada lado?</h2>
          <button className="btn btn--ghost btn--icon" type="button" aria-label="Cerrar" title="Cerrar" onClick={onCancel}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="player-dialog__description">Cada jugador tendrá su color y su inicial en el mapa de pista.</p>
        <label className="player-dialog__field">
          <span>
            <b className="player-dialog__badge player-dialog__badge--far" aria-hidden="true">F</b>
            Fondo <small>Lado opuesto a la cámara</small>
          </span>
          <input
            className="field__control"
            autoFocus
            required
            maxLength={80}
            type="text"
            autoComplete="name"
            placeholder="Nombre del jugador"
            value={names.far}
            onChange={(event) => setNames({ ...names, far: event.target.value })}
          />
        </label>
        <label className="player-dialog__field">
          <span>
            <b className="player-dialog__badge player-dialog__badge--near" aria-hidden="true">C</b>
            Cámara <small>Lado más cercano</small>
          </span>
          <input
            className="field__control"
            required
            maxLength={80}
            type="text"
            autoComplete="name"
            placeholder="Nombre del jugador"
            value={names.near}
            onChange={(event) => setNames({ ...names, near: event.target.value })}
          />
        </label>
        {error ? <p className="player-dialog__error" role="alert">{error}</p> : null}
        <div className="player-dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onCancel}>
            Ahora no
          </button>
          <button className="btn btn--primary" type="submit">
            <Video size={16} aria-hidden="true" /> Guardar y analizar
          </button>
        </div>
      </form>
    </dialog>
  )
}
