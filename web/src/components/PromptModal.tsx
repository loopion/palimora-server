import { useCallback, useRef, useState } from 'react'
import { Button } from './ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'

interface PromptOpts {
  title: string
  label?: string
  initial?: string
  placeholder?: string
}

export function usePrompt() {
  const [opts, setOpts] = useState<PromptOpts | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<((v: string | null) => void) | null>(null)

  const prompt = useCallback((o: PromptOpts) => {
    setOpts(o)
    setValue(o.initial ?? '')
    return new Promise<string | null>((resolve) => { resolver.current = resolve })
  }, [])

  const close = (result: string | null) => {
    resolver.current?.(result)
    resolver.current = null
    setOpts(null)
  }

  const node = opts ? (
    <Dialog open onOpenChange={(open) => { if (!open) close(null) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">{opts.title}</DialogTitle>
        </DialogHeader>
        {opts.label && <label className="text-xs text-muted-foreground">{opts.label}</label>}
        <Input
          autoFocus
          placeholder={opts.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') close(value) }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(null)}>Annuler</Button>
          <Button onClick={() => close(value)}>Valider</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  return { prompt, node }
}
