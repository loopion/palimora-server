import { useCallback, useRef, useState } from 'react'

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
         onMouseDown={() => close(null)}>
      <div className="bg-white rounded-lg shadow-xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold mb-2">{opts.title}</h2>
        {opts.label && <label className="text-xs text-slate-500">{opts.label}</label>}
        <input autoFocus className="w-full border rounded-md px-2 py-1.5 text-sm mt-1"
               placeholder={opts.placeholder}
               value={value} onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') close(value)
                 if (e.key === 'Escape') close(null)
               }} />
        <div className="flex justify-end gap-2 mt-3 text-sm">
          <button className="px-3 py-1 text-slate-500" onClick={() => close(null)}>Annuler</button>
          <button className="px-3 py-1 bg-indigo-600 text-white rounded-md"
                  onClick={() => close(value)}>Valider</button>
        </div>
      </div>
    </div>
  ) : null

  return { prompt, node }
}
