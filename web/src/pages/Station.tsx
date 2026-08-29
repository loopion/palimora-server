import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, getToken, Me, PageDetail, PageSummary, QueueItem, Segment, setToken } from '../api'

const statusBadge: Record<string, string> = {
  draft: 'bg-slate-200 text-slate-700',
  queued: 'bg-amber-100 text-amber-800',
  processing: 'bg-blue-100 text-blue-800',
  to_review: 'bg-violet-100 text-violet-800',
  validated: 'bg-emerald-100 text-emerald-800',
}

function confColor(c: number) {
  if (c >= 0.9) return 'border-emerald-400 bg-emerald-50'
  if (c >= 0.7) return 'border-amber-400 bg-amber-50'
  return 'border-red-400 bg-red-50'
}

export default function Station() {
  const [me, setMe] = useState<Me | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [docId, setDocId] = useState<string | null>(null)
  const [pages, setPages] = useState<PageSummary[]>([])
  const [pageId, setPageId] = useState<string | null>(null)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const navigate = useNavigate()

  const notify = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  const refreshQueue = useCallback(async () => {
    const data = await api.get<{ queue: QueueItem[] }>('/api/queue')
    setQueue(data.queue)
  }, [])

  useEffect(() => {
    api.get<Me>('/api/auth/me').then(setMe).catch(() => navigate('/login'))
    refreshQueue()
    const t = setInterval(refreshQueue, 3000)
    return () => clearInterval(t)
  }, [refreshQueue, navigate])

  const loadPages = useCallback(async (id: string) => {
    const data = await api.get<{ pages: PageSummary[] }>(`/api/documents/${id}`)
    setPages(data.pages)
  }, [])

  const loadPage = useCallback(async (id: string) => {
    setPageId(id)
    const data = await api.get<PageDetail>(`/api/pages/${id}`)
    setPage(data)
  }, [])

  async function selectDoc(id: string) {
    setDocId(id)
    setPage(null)
    setPageId(null)
    await loadPages(id)
  }

  // ---- upload flow
  const fileInput = useRef<HTMLInputElement>(null)
  async function handleUpload(files: FileList | null) {
    if (!files || !docId) return
    setBusy('upload')
    try {
      const pageIds: string[] = []
      for (const file of Array.from(files)) {
        const ct = file.type || 'application/octet-stream'
        const up = await api.post<{ page_id: string; upload_url: string }>(
          `/api/documents/${docId}/pages/upload-url`, { content_type: ct, size_bytes: file.size })
        const put = await fetch(up.upload_url, { method: 'PUT', body: file,
          headers: { 'Content-Type': ct } })
        if (!put.ok) throw new Error(`Échec upload ${file.name} (${put.status})`)
        pageIds.push(up.page_id)
      }
      const res = await api.post<{ credits_charged: number }>(
        `/api/documents/${docId}/finalize`, { page_ids: pageIds })
      notify(`${pageIds.length} page(s) en file — ${res.credits_charged} crédits débités`)
      await loadPages(docId)
      refreshQueue()
    } catch (err: any) {
      notify(err.message || 'Échec de l’upload')
    } finally {
      setBusy('')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function newDocument() {
    const title = prompt('Titre du document :')
    if (!title) return
    const data = await api.post<{ id: string }>('/api/documents', { title })
    await refreshQueue()
    await selectDoc(data.id)
    notify('Document créé — sélectionne des fichiers à envoyer')
  }

  // ---- editor actions
  const [editMode, setEditMode] = useState<'segments' | 'text'>('segments')
  const [fullText, setFullText] = useState('')

  async function saveSegment(seg: Segment, text: string, validated?: boolean) {
    await api.patch(`/api/pages/${pageId}/transcription`, {
      segment_updates: [{ segment_id: seg.id, edited_text: text, is_validated: validated }],
    })
    setPage((p) => p ? {
      ...p,
      segments: p.segments.map((s) => s.id === seg.id
        ? { ...s, edited_text: text, is_validated: validated ?? s.is_validated } : s),
    } : p)
  }

  async function saveFullText() {
    await api.patch(`/api/pages/${pageId}/transcription`, { edited_text: fullText })
    notify('Texte enregistré')
    await loadPage(pageId!)
  }

  async function validatePage() {
    await api.post(`/api/pages/${pageId}/validate`)
    notify('Page validée')
    await Promise.all([loadPage(pageId!), loadPages(docId!), refreshQueue()])
  }

  async function reocr() {
    setBusy('reocr')
    try {
      await api.post(`/api/pages/${pageId}/reocr`)
      notify('Ré-OCR lancé')
      await loadPage(pageId!)
      refreshQueue()
    } catch (err: any) { notify(err.message) } finally { setBusy('') }
  }

  async function aiSuggest() {
    setBusy('ai')
    try {
      const data = await api.post<{ suggestions: any[] }>(`/api/pages/${pageId}/ai-suggest`, {})
      setPage((p) => p ? { ...p, suggestions: data.suggestions } : p)
      notify(`${data.suggestions.length} suggestion(s)`)
    } catch (err: any) { notify(err.message) } finally { setBusy('') }
  }

  async function decide(suggestionId: string, accept: boolean) {
    await api.post(`/api/suggestions/${suggestionId}/${accept ? 'accept' : 'reject'}`)
    await loadPage(pageId!)
  }

  async function validateDoc(doc: QueueItem) {
    await api.post(`/api/documents/${doc.id}/validate`)
    await Promise.all([refreshQueue(), doc.id === docId ? loadPages(doc.id) : Promise.resolve()])
    notify('Document validé')
  }

  return (
    <div className="h-screen flex flex-col">
      {/* top bar */}
      <header className="bg-white border-b px-4 py-2 flex items-center gap-3">
        <span className="text-xl font-semibold">📜 Palimora</span>
        <span className="text-sm bg-indigo-50 text-indigo-700 rounded-full px-3 py-1">
          {me ? `${me.credit_balance} crédits` : '…'}
        </span>
        <div className="flex-1" />
        {me?.is_admin && <Link className="text-sm text-slate-500 hover:text-slate-800" to="/admin">Admin</Link>}
        <button className="text-sm text-slate-500 hover:text-slate-800"
                onClick={() => { setToken(null); navigate('/login') }}>Déconnexion</button>
      </header>

      {/* ZONE 1 — queue (horizontal third) */}
      <section className="bg-slate-50 border-b px-4 py-3" style={{ height: '33vh' }}>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-slate-600">File de traitement</h2>
          <button onClick={newDocument}
                  className="text-xs bg-indigo-600 text-white rounded-md px-2 py-1">+ Document</button>
          <label className={`text-xs bg-slate-200 text-slate-700 rounded-md px-2 py-1 cursor-pointer
                             ${docId ? '' : 'opacity-40 pointer-events-none'}`}>
            {busy === 'upload' ? 'Envoi…' : '+ Envoyer des fichiers'}
            <input ref={fileInput} type="file" multiple hidden
                   accept="image/png,image/jpeg,image/webp,image/tiff,image/heic,image/heif,application/pdf"
                   onChange={(e) => handleUpload(e.target.files)} />
          </label>
          {!docId && <span className="text-xs text-slate-400">sélectionne un document ci-dessous</span>}
        </div>
        <div className="flex gap-3 overflow-x-auto thin-scroll pb-1">
          {queue.map((d) => (
            <button key={d.id} onClick={() => selectDoc(d.id)}
                    className={`min-w-56 text-left bg-white rounded-lg border p-3 shadow-sm hover:border-indigo-400
                                ${docId === d.id ? 'border-indigo-500 ring-1 ring-indigo-400' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate">{d.title}</span>
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${statusBadge[d.status] || ''}`}>
                  {d.status}
                </span>
              </div>
              <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500" style={{
                  width: d.pages ? `${Math.round((d.done / d.pages) * 100)}%` : '0%' }} />
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                <span>{d.done}/{d.pages} pages</span>
                {d.validated > 0 && <span className="text-emerald-600">✓ {d.validated}</span>}
                {d.error > 0 && <span className="text-red-600">⚠ {d.error}</span>}
                <div className="flex-1" />
                {d.status !== 'validated' && d.done === d.pages && d.pages > 0 && (
                  <span role="button" className="text-indigo-600"
                        onClick={(e) => { e.stopPropagation(); validateDoc(d) }}>Valider</span>
                )}
              </div>
            </button>
          ))}
          {queue.length === 0 && (
            <p className="text-sm text-slate-400 p-4">Aucun document — crée-en un puis envoie des captures.</p>
          )}
        </div>
      </section>

      {/* ZONES 2 & 3 — viewer / editor split */}
      <main className="flex-1 flex min-h-0">
        <Viewer page={page} pages={pages} onSelect={loadPage} />
        <section className="w-1/2 border-l flex flex-col min-h-0">
          {page ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-white">
                <h3 className="text-sm font-semibold">Page {page.page_number}</h3>
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${statusBadge[page.processing_status] || 'bg-slate-100'}`}>
                  {page.processing_status}
                </span>
                <div className="flex-1" />
                <div className="flex text-xs rounded-md overflow-hidden border">
                  <button className={`px-2 py-1 ${editMode === 'segments' ? 'bg-indigo-600 text-white' : ''}`}
                          onClick={() => setEditMode('segments')}>Segments</button>
                  <button className={`px-2 py-1 ${editMode === 'text' ? 'bg-indigo-600 text-white' : ''}`}
                          onClick={() => { setEditMode('text'); setFullText(page.transcription?.edited_text || page.transcription?.raw_htr_text || '') }}>
                    Texte
                  </button>
                </div>
              </div>

              {page.error && <p className="text-sm text-red-600 px-3 py-2 bg-red-50">{page.error}</p>}

              {editMode === 'segments' ? (
                <div className="flex-1 overflow-y-auto thin-scroll p-3 space-y-2">
                  {page.segments.length === 0 && <p className="text-sm text-slate-400">Aucun segment.</p>}
                  {page.segments.map((s) => (
                    <SegmentRow key={s.id} seg={s} onSave={saveSegment} />
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex flex-col p-3 gap-2 min-h-0">
                  <textarea className="flex-1 border rounded-lg p-3 font-mono text-sm resize-none thin-scroll"
                            value={fullText} onChange={(e) => setFullText(e.target.value)} />
                  <button onClick={saveFullText}
                          className="self-end bg-slate-800 text-white text-sm rounded-md px-3 py-1.5">
                    Enregistrer le texte
                  </button>
                </div>
              )}

              {/* AI suggestions */}
              <div className="border-t px-3 py-2 bg-white">
                <div className="flex items-center gap-2">
                  <button onClick={aiSuggest} disabled={busy === 'ai'}
                          className="text-xs bg-violet-600 text-white rounded-md px-3 py-1.5 disabled:opacity-50">
                    {busy === 'ai' ? 'IA en cours…' : '✨ Correction IA'}
                  </button>
                  <button onClick={reocr} disabled={busy === 'reocr'}
                          className="text-xs bg-slate-200 rounded-md px-3 py-1.5 disabled:opacity-50">
                    ↻ Ré-OCR
                  </button>
                  <div className="flex-1" />
                  <button onClick={validatePage}
                          className="text-xs bg-emerald-600 text-white rounded-md px-3 py-1.5">
                    ✓ Valider la page
                  </button>
                </div>
                {page.suggestions.length > 0 && (
                  <div className="mt-2 space-y-2 max-h-40 overflow-y-auto thin-scroll">
                    {page.suggestions.map((s) => (
                      <div key={s.id} className={`border rounded-md p-2 text-sm ${s.status === 'accepted' ? 'border-emerald-300 bg-emerald-50' : s.status === 'rejected' ? 'opacity-50 border-slate-200' : 'border-violet-200 bg-violet-50'}`}>
                        <p><span className="line-through text-red-600">{s.original_text}</span>
                           {' → '}<span className="text-emerald-700">{s.suggested_text}</span></p>
                        {s.explanation && <p className="text-xs text-slate-500 mt-0.5">{s.explanation}</p>}
                        {s.status === 'pending' && (
                          <div className="mt-1 flex gap-2 text-xs">
                            <button className="text-emerald-700 font-medium"
                                    onClick={() => decide(s.id, true)}>Appliquer</button>
                            <button className="text-slate-500"
                                    onClick={() => decide(s.id, false)}>Ignorer</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Sélectionne une page (vignettes à gauche) pour l’éditer.
            </div>
          )}
        </section>
      </main>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm rounded-lg px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function SegmentRow({ seg, onSave }: { seg: Segment; onSave: (s: Segment, t: string, v?: boolean) => void }) {
  const [text, setText] = useState(seg.edited_text || seg.source_text)
  const dirty = text !== (seg.edited_text || seg.source_text)
  return (
    <div className={`border rounded-md px-2 py-1.5 flex items-start gap-2 ${confColor(seg.confidence)}`}>
      <span className="text-[10px] text-slate-500 w-8 pt-2 text-right">{Math.round(seg.confidence * 100)}%</span>
      <input className="flex-1 bg-transparent text-sm outline-none"
             value={text} onChange={(e) => setText(e.target.value)}
             onBlur={() => dirty && onSave(seg, text)} />
      <button className={`text-[10px] pt-1 ${seg.is_validated ? 'text-emerald-600' : 'text-slate-300'}`}
              title="Valider la ligne"
              onClick={() => onSave(seg, text, !seg.is_validated)}>✓</button>
    </div>
  )
}

function Viewer({ page, pages, onSelect }: {
  page: PageDetail | null; pages: PageSummary[]; onSelect: (id: string) => void
}) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [imgSrc, setImgSrc] = useState('')
  const drag = useRef<{ x: number; y: number } | null>(null)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setScale(1); setPos({ x: 0, y: 0 }); setImgSrc('')
    let objectUrl = ''
    const url = page?.image_url
    if (url) {
      if (url.startsWith('/api/')) {
        fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
          .then((r) => { if (!r.ok) throw new Error('image'); return r.blob() })
          .then((b) => { objectUrl = URL.createObjectURL(b); setImgSrc(objectUrl) })
          .catch(() => setImgSrc(''))
      } else {
        setImgSrc(url)
      }
    }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [page?.id, page?.image_url])

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setScale((s) => Math.min(8, Math.max(0.2, s * factor)))
  }

  function onMouseDown(e: React.MouseEvent) {
    drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!drag.current) return
    setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
  }
  function stop() { drag.current = null }

  return (
    <section className="w-1/2 flex flex-col min-h-0">
      <div ref={frame} className="flex-1 overflow-hidden bg-slate-800 relative cursor-grab"
           onWheel={onWheel} onMouseDown={onMouseDown}
           onMouseMove={onMouseMove} onMouseUp={stop} onMouseLeave={stop}>
        {imgSrc ? (
          <img src={imgSrc} alt={`Page ${page?.page_number ?? ''}`}
               draggable={false}
               className="absolute origin-top-left select-none"
               style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }} />
        ) : (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            {page ? 'Image indisponible' : 'Aucune page sélectionnée'}
          </div>
        )}
        <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs rounded px-2 py-1">
          🔍 {Math.round(scale * 100)}%
        </div>
      </div>
      <div className="h-20 bg-white border-t flex gap-2 p-2 overflow-x-auto thin-scroll">
        {pages.map((p) => (
          <button key={p.id} onClick={() => onSelect(p.id)}
                  className={`min-w-14 h-full rounded border text-[10px] relative
                              ${page?.id === p.id ? 'border-indigo-500 ring-1 ring-indigo-300' : 'border-slate-200'}`}>
            <span className="absolute bottom-0 right-1 bg-slate-900/70 text-white rounded px-1">
              {p.page_number}
            </span>
            <StatusDot status={p.processing_status} />
          </button>
        ))}
      </div>
    </section>
  )
}

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    done: 'bg-emerald-500', error: 'bg-red-500', transcribing: 'bg-blue-500 animate-pulse',
    queued: 'bg-amber-400', idle: 'bg-slate-300',
  }
  return <span className={`absolute top-1 left-1 w-2 h-2 rounded-full ${color[status] || 'bg-slate-300'}`} />
}
