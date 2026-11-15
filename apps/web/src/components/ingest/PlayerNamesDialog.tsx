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
          <div className="player-dialog__mark" aria-hidden="true">NP</div>
          <button className="player-dialog__close" type="button" aria-label="Cerrar" title="Cerrar" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <span className="eyebrow">IDENTIFICACIÓN DE JUGADORES</span>
        <h2 id="player-dialog-title">¿Quién juega cada lado?</h2>
        <p className="player-dialog__description">Sus iniciales aparecerán en el mapa de pista.</p>
        <label className="player-dialog__field">
          <span><b>F</b> Fondo <small>Lado opuesto a la cámara</small></span>
          <input
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
          <span><b>C</b> Cámara <small>Lado más cercano</small></span>
          <input
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
          <button className="player-dialog__cancel" type="button" onClick={onCancel}>
            Ahora no
          </button>
          <button className="player-dialog__confirm" type="submit">
            Guardar y analizar <Video size={16} />
          </button>
        </div>
      </form>
    </dialog>
  )
}
