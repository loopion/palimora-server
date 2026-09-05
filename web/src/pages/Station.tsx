import { useCallback, useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { Link, useNavigate } from 'react-router-dom'
import { api, getImpersonation, getToken, Me, PageDetail, PageSummary, QueueItem, Segment, setToken } from '../api'
import Mark from '../components/Mark'
import { usePrompt } from '../components/PromptModal'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'

const statusBadge: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  queued: 'bg-warning/15 text-warning',
  processing: 'bg-primary/10 text-primary',
  to_review: 'bg-primary/15 text-primary',
  validated: 'bg-success/15 text-success',
}

function confColor(c: number) {
  if (c >= 0.9) return 'border-success/50 bg-success/8'
  if (c >= 0.7) return 'border-warning/50 bg-warning/8'
  return 'border-destructive/50 bg-destructive/8'
}

interface SearchHit {
  document_id: string
  document_title: string
  page_id: string
  page_number: number
  segment_id: string
  snippet: string
}

export default function Station() {
  const [me, setMe] = useState<Me | null>(null)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [docId, setDocId] = useState<string | null>(null)
  const [pages, setPages] = useState<PageSummary[]>([])
  const [pageId, setPageId] = useState<string | null>(null)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const { prompt: showPrompt, node: promptNode } = usePrompt()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const notify = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  // ---- panneaux redimensionnables (persistés)
  const clampQueueH = (h: number) =>
    Math.max(120, Math.min(window.innerHeight - 220, h))
  const [queueH, setQueueH] = useState(
    () => clampQueueH(Number(localStorage.getItem('palimora_queueH'))
      || Math.round(window.innerHeight * 0.3)))
  const [viewerW, setViewerW] = useState(
    () => Number(localStorage.getItem('palimora_viewerW')) || 0.5)
  useEffect(() => { localStorage.setItem('palimora_queueH', String(queueH)) }, [queueH])
  useEffect(() => { localStorage.setItem('palimora_viewerW', String(viewerW)) }, [viewerW])
  // Re-clamp quand la fenêtre rétrécit — sinon la file peut écraser l'éditeur.
  useEffect(() => {
    const onResize = () => setQueueH((h) => clampQueueH(h))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Nettoyage des listeners de drag si le composant est démonté pendant un glisser.
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  function dragQueue(e: React.MouseEvent) {
    e.preventDefault()
    const start = e.clientY
    const base = queueH
    const move = (ev: MouseEvent) => setQueueH(clampQueueH(base + ev.clientY - start))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
    }
    dragCleanup.current = up
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  function dragSplit(e: React.MouseEvent) {
    e.preventDefault()
    const start = e.clientX
    const base = viewerW
    const total = window.innerWidth
    const move = (ev: MouseEvent) =>
      setViewerW(Math.max(0.2, Math.min(0.8, base + (ev.clientX - start) / total)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
    }
    dragCleanup.current = up
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

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
    return data.pages
  }, [])

  const loadPage = useCallback(async (id: string, segmentId?: string) => {
    setPageId(id)
    setActiveSegmentId(segmentId ?? null)
    const data = await api.get<PageDetail>(`/api/pages/${id}`)
    setPage(data)
  }, [])

  async function selectDoc(id: string, autoLoadFirst = true) {
    setDocId(id)
    setPage(null)
    setPageId(null)
    setActiveSegmentId(null)
    const pgs = await loadPages(id)
    // Auto-sélection de la première page — évite d'avoir à cliquer une vignette.
    // Sauté quand l'appelant va charger une page précise (résultat de recherche).
    if (autoLoadFirst && pgs.length) await loadPage(pgs[0].id)
  }

  // ---- keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      const idx = pages.findIndex((p) => p.id === pageId)
      if (e.key === 'ArrowRight' && idx < pages.length - 1) {
        loadPage(pages[idx + 1].id)
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        loadPage(pages[idx - 1].id)
      } else if (e.key === 'v' && pageId) {
        validatePage()
      } else if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- search
  useEffect(() => {
    if (searchQuery.trim().length < 2) { setSearchHits(null); return }
    const t = setTimeout(async () => {
      try {
        const data = await api.get<{ results: SearchHit[] }>(
          `/api/search?q=${encodeURIComponent(searchQuery.trim())}`)
        setSearchHits(data.results)
      } catch { setSearchHits(null) }
    }, 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  async function openHit(hit: SearchHit) {
    if (hit.document_id !== docId) await selectDoc(hit.document_id, false)
    await loadPage(hit.page_id, hit.segment_id)
    setSearchHits(null)
    setSearchQuery('')
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
        const up = await api.post<{ page_id: string; upload_url: string | null }>(
          `/api/documents/${docId}/pages/upload-url`, { content_type: ct, size_bytes: file.size })
        if (up.upload_url) {
          const put = await fetch(up.upload_url, { method: 'PUT', body: file,
            headers: { 'Content-Type': ct } })
          if (!put.ok) throw new Error(`Echec upload ${file.name} (${put.status})`)
        } else {
          const form = new FormData()
          form.append('file', file)
          const posted = await fetch(`/api/pages/${up.page_id}/upload`, {
            method: 'POST', body: form,
            headers: {
              Authorization: `Bearer ${getToken()}`,
              ...(getImpersonation() ? { 'X-Impersonate': getImpersonation()!.id } : {}),
            },
          })
          if (!posted.ok) throw new Error(`Echec upload ${file.name} (${posted.status})`)
        }
        pageIds.push(up.page_id)
      }
      const res = await api.post<{ credits_charged: number }>(
        `/api/documents/${docId}/finalize`, { page_ids: pageIds })
      notify(`${pageIds.length} page(s) en file — ${res.credits_charged} crédits débités`)
      await loadPages(docId)
      refreshQueue()
    } catch (err: any) {
      notify(err.message || 'Echec de l’upload')
    } finally {
      setBusy('')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function newDocument() {
    const title = await showPrompt({ title: 'Nouveau document', label: 'Titre', placeholder: 'Liste Augustin…' })
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

  async function editTags(doc: QueueItem, e: React.MouseEvent) {
    e.stopPropagation()
    const next = await showPrompt({
      title: 'Dossier / tags', label: 'Séparés par des virgules',
      initial: doc.tags.join(', '),
    })
    if (next === null) return
    const tags = [...new Set(next.split(',').map((t) => t.trim()).filter(Boolean))]
    try {
      await api.patch(`/api/documents/${doc.id}`, { tags })
      refreshQueue()
    } catch (err: any) { notify(err.message || 'Échec de la mise à jour des tags') }
  }

  // Regroupement de la file par dossier (= premier tag)
  const UNTAGGED = 'Sans dossier'
  const groupedQueue = (() => {
    const groups = new Map<string, QueueItem[]>()
    for (const d of queue) {
      const key = d.tags[0] || UNTAGGED
      let arr = groups.get(key)
      if (!arr) groups.set(key, arr = [])
      arr.push(d)
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === UNTAGGED) return 1
      if (b === UNTAGGED) return -1
      return a.localeCompare(b)
    })
  })()

  function onSegmentClick(seg: Segment) {
    setActiveSegmentId(seg.id)
    document.getElementById(`seg-${seg.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  return (
    <div className="h-screen flex flex-col">
      <header className="bg-card border-b px-4 py-2.5 flex items-center gap-3 relative">
        <span className="flex items-center gap-2">
          <Mark size={26} />
          <span className="font-display text-lg font-semibold">Palimora</span>
        </span>
        <Badge variant="secondary">{me ? `${me.credit_balance} crédits` : '…'}</Badge>
        <Button variant="link" size="sm" asChild>
          <Link to="/billing">Acheter des crédits</Link>
        </Button>
        <div className="flex-1 max-w-md relative">
          <Input ref={searchInputRef}
                 placeholder="Rechercher dans les transcriptions… ( / )"
                 value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          {searchHits && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg max-h-80 overflow-y-auto thin-scroll z-50">
              {searchHits.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">Aucun résultat.</p>
              )}
              {searchHits.map((h, i) => (
                <button key={i} onClick={() => openHit(h)}
                        className="w-full text-left px-3 py-2 hover:bg-muted border-b last:border-0">
                  <p className="text-xs text-muted-foreground">{h.document_title} — page {h.page_number}</p>
                  <p className="text-sm">…{h.snippet}…</p>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1" />
        {me?.is_admin && (
          <Button variant="ghost" size="sm" asChild><Link to="/admin">Admin</Link></Button>
        )}
        <Button variant="ghost" size="sm"
                onClick={() => { setToken(null); navigate('/login') }}>Déconnexion</Button>
      </header>

      {/* ZONE 1 — file de traitement */}
      <section className="bg-muted border-b px-4 py-3 shrink-0 flex flex-col min-h-0"
               style={{ height: queueH }}>
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <h2 className="font-display text-sm font-semibold">File de traitement</h2>
          <Button size="xs" onClick={newDocument}>+ Document</Button>
          <label className={`inline-flex h-6 cursor-pointer items-center rounded-lg bg-secondary
                             px-2 text-xs font-medium text-secondary-foreground
                             ${docId ? '' : 'opacity-40 pointer-events-none'}`}>
            {busy === 'upload' ? 'Envoi…' : '+ Envoyer des fichiers'}
            <input ref={fileInput} type="file" multiple hidden
                   accept="image/png,image/jpeg,image/webp,image/tiff,image/heic,image/heif,application/pdf"
                   onChange={(e) => handleUpload(e.target.files)} />
          </label>
          {!docId && (
            <span className="text-xs text-muted-foreground">sélectionne un document ci-dessous</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto thin-scroll space-y-3">
          {queue.length === 0 && (
            <p className="text-sm text-muted-foreground p-4">
              Aucun document — crée-en un puis envoie des captures.
            </p>
          )}
          {groupedQueue.map(([group, docs]) => (
            <div key={group}>
              <div className="flex items-center gap-1.5 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>{group === UNTAGGED ? '📄' : '📁'}</span>
                <span>{group}</span>
                <span className="opacity-60">({docs.length})</span>
              </div>
              <div className="flex gap-3 overflow-x-auto thin-scroll pb-1">
                {docs.map((d) => (
                  <div key={d.id} onClick={() => selectDoc(d.id)}
                       className={`min-w-56 cursor-pointer text-left bg-card rounded-lg border p-3 shadow-sm transition-colors hover:border-primary/50
                                   ${docId === d.id ? 'border-primary ring-1 ring-primary/40' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">{d.title}</span>
                      <span className={`text-[10px] rounded-full px-2 py-0.5 ${statusBadge[d.status] || ''}`}>
                        {d.status}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {d.tags.map((t) => (
                        <span key={t} className="text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">{t}</span>
                      ))}
                      <button className="text-[10px] text-primary hover:underline"
                              onClick={(e) => editTags(d, e)}>
                        {d.tags.length ? 'éditer' : '＋ dossier'}
                      </button>
                    </div>
                    <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary" style={{
                        width: d.pages ? `${Math.round((d.done / d.pages) * 100)}%` : '0%' }} />
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{d.done}/{d.pages} pages</span>
                      {d.validated > 0 && <span className="text-success">✓ {d.validated}</span>}
                      {d.error > 0 && <span className="text-destructive">⚠ {d.error}</span>}
                      <div className="flex-1" />
                      {d.status !== 'validated' && d.done === d.pages && d.pages > 0 && (
                        <span role="button" className="text-primary font-medium"
                              onClick={(e) => { e.stopPropagation(); validateDoc(d) }}>Valider</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* poignée de redimensionnement vertical */}
      <div onMouseDown={dragQueue}
           className="h-1.5 bg-border hover:bg-primary cursor-row-resize shrink-0 transition-colors" />

      {/* ZONES 2 & 3 */}
      <main className="flex-1 flex min-h-0">
        <Viewer page={page} pages={pages} onSelect={loadPage} activeSegmentId={activeSegmentId}
                onSegmentPick={onSegmentClick} widthPct={viewerW} />
        <div onMouseDown={dragSplit}
             className="w-1.5 bg-border hover:bg-primary cursor-col-resize shrink-0 transition-colors" />
        <section className="flex-1 min-w-0 border-l flex flex-col min-h-0">
          <div className="px-3 py-2 border-b bg-card font-display text-sm font-semibold shrink-0">
            Transcription
          </div>
          {page ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-card">
                <h3 className="font-display text-sm font-semibold">Page {page.page_number}</h3>
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${statusBadge[page.processing_status] || 'bg-muted'}`}>
                  {page.processing_status}
                </span>
                <div className="flex-1" />
                <Tabs value={editMode}
                      onValueChange={(v) => {
                        setEditMode(v as 'segments' | 'text')
                        if (v === 'text') {
                          setFullText(page.transcription?.edited_text
                            || page.transcription?.raw_htr_text || '')
                        }
                      }}>
                  <TabsList>
                    <TabsTrigger value="segments">Segments</TabsTrigger>
                    <TabsTrigger value="text">Texte</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {page.error && (
                <p className="text-sm text-destructive px-3 py-2 bg-destructive/10">{page.error}</p>
              )}

              {editMode === 'segments' ? (
                <div className="flex-1 overflow-y-auto thin-scroll p-3 space-y-2">
                  {page.segments.length === 0 && (
                    <p className="text-sm text-muted-foreground">Aucun segment.</p>
                  )}
                  {page.segments.map((s) => (
                    <div key={s.id} id={`seg-${s.id}`}
                         className={`border rounded-md px-2 py-1.5 flex items-start gap-2 cursor-pointer transition
                                     ${activeSegmentId === s.id ? 'ring-2 ring-primary/50 ' : ''}${confColor(s.confidence)}`}
                         onClick={() => setActiveSegmentId(s.id)}>
                      <span className="text-[10px] text-muted-foreground w-8 pt-2 text-right">
                        {Math.round(s.confidence * 100)}%
                      </span>
                      <SegmentInput seg={s} onSave={saveSegment} />
                      <button className={`text-[10px] pt-1 ${s.is_validated ? 'text-success' : 'text-muted-foreground/40'}`}
                              title="Valider la ligne"
                              onClick={(e) => { e.stopPropagation(); saveSegment(s, s.edited_text || s.source_text, !s.is_validated) }}>✓</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex flex-col p-3 gap-2 min-h-0">
                  <textarea className="flex-1 bg-card border rounded-lg p-3 font-mono text-sm resize-none thin-scroll
                                       outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                            value={fullText} onChange={(e) => setFullText(e.target.value)} />
                  <Button className="self-end" onClick={saveFullText}>Enregistrer le texte</Button>
                </div>
              )}

              <div className="border-t px-3 py-2 bg-card">
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={aiSuggest} disabled={busy === 'ai'}>
                    {busy === 'ai' ? 'IA en cours…' : '✨ Correction IA'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={reocr} disabled={busy === 'reocr'}>
                    ↻ Ré-OCR
                  </Button>
                  <div className="flex-1" />
                  <Button size="sm" variant="outline" onClick={validatePage}>
                    ✓ Valider la page (V)
                  </Button>
                </div>
                {page.suggestions.length > 0 && (
                  <div className="mt-2 space-y-2 max-h-40 overflow-y-auto thin-scroll">
                    {page.suggestions.map((s) => (
                      <div key={s.id} className={`border rounded-md p-2 text-sm ${s.status === 'accepted' ? 'border-success/40 bg-success/8' : s.status === 'rejected' ? 'opacity-50' : 'border-primary/30 bg-primary/5'}`}>
                        <p><span className="line-through text-destructive">{s.original_text}</span>
                           {' → '}<span className="text-success">{s.suggested_text}</span></p>
                        {s.explanation && (
                          <p className="text-xs text-muted-foreground mt-0.5">{s.explanation}</p>
                        )}
                        {s.status === 'pending' && (
                          <div className="mt-1 flex gap-2">
                            <Button size="xs" onClick={() => decide(s.id, true)}>Appliquer</Button>
                            <Button size="xs" variant="ghost"
                                    onClick={() => decide(s.id, false)}>Ignorer</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Sélectionne une page (vignettes à gauche) pour l’éditer.
            </div>
          )}
        </section>
      </main>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-foreground text-background text-sm rounded-lg px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
      {promptNode}
    </div>
  )
}

function SegmentInput({ seg, onSave }: { seg: Segment; onSave: (s: Segment, t: string, v?: boolean) => void }) {
  const [text, setText] = useState(seg.edited_text || seg.source_text)
  const [initial, setInitial] = useState(seg.edited_text || seg.source_text)
  if ((seg.edited_text || seg.source_text) !== initial) {
    setInitial(seg.edited_text || seg.source_text)
    setText(seg.edited_text || seg.source_text)
  }
  const dirty = text !== (seg.edited_text || seg.source_text)
  return (
    <input className="flex-1 bg-transparent text-sm outline-none"
           value={text} onChange={(e) => setText(e.target.value)}
           onBlur={() => dirty && onSave(seg, text)} />
  )
}

function Viewer({ page, pages, onSelect, activeSegmentId, onSegmentPick, widthPct }: {
  page: PageDetail | null
  pages: PageSummary[]
  onSelect: (id: string, segmentId?: string) => void
  activeSegmentId: string | null
  onSegmentPick: (seg: Segment) => void
  widthPct: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)
  const pageRef = useRef<PageDetail | null>(null)
  const [zoomLabel, setZoomLabel] = useState(100)
  const [imageError, setImageError] = useState(false)
  pageRef.current = page

  const [imgSrc, setImgSrc] = useState('')
  useEffect(() => {
    let objectUrl = ''
    setImgSrc('')
    setImageError(false)
    const url = page?.image_url
    if (url) {
      if (url.startsWith('/api/')) {
        fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
          .then((r) => { if (!r.ok) throw new Error('image'); return r.blob() })
          .then((b) => { objectUrl = URL.createObjectURL(b); setImgSrc(objectUrl) })
          .catch(() => setImageError(true))
      } else {
        setImgSrc(url)
      }
    }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [page?.id, page?.image_url])

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return
    const viewer = OpenSeadragon({
      element: containerRef.current,
      showNavigator: false,
      showZoomControl: false,
      showHomeControl: false,
      showFullPageControl: false,
      defaultZoomLevel: 0.9,
      minZoomLevel: 0.2,
      maxZoomLevel: 12,
      visibilityRatio: 0.9,
    })
    viewer.addHandler('zoom', (e: any) => setZoomLabel(Math.round(e.zoom * 100)))
    viewer.addHandler('canvas-click', (e: any) => {
      if (e.quick && viewerRef.current) {
        const vp = viewerRef.current.viewport.pointFromPixel(e.position)
        const img = viewerRef.current.viewport.viewportToImageCoordinates(vp)
        const segments = pageRef.current?.segments || []
        for (const seg of segments) {
          const box = bboxRect(seg.bbox)
          if (box && img.x >= box[0] && img.x <= box[0] + box[2] && img.y >= box[1] && img.y <= box[1] + box[3]) {
            onSegmentPick(seg)
            return
          }
        }
      }
    })
    viewerRef.current = viewer
    return () => { viewer.destroy(); viewerRef.current = null }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !imgSrc) return
    viewer.open({ type: 'image', url: imgSrc, buildPyramid: false })
    // À l'ouverture le conteneur flex a souvent une taille périmée : l'image
    // reste alors invisible jusqu'à ce qu'une opération de viewport force un
    // redraw (clic sur un segment, zoom…). On recale plusieurs fois sur la
    // taille réelle du conteneur après stabilisation du layout.
    const timeouts: number[] = []
    let raf = 0
    const recenter = () => {
      const c = containerRef.current
      if (c) viewer.viewport.resize(new OpenSeadragon.Point(c.clientWidth, c.clientHeight), false)
      viewer.viewport.goHome(true)
      viewer.forceRedraw()
    }
    const onOpen = () => {
      recenter()
      raf = requestAnimationFrame(recenter)
      timeouts.push(window.setTimeout(recenter, 120))
      timeouts.push(window.setTimeout(recenter, 400))
    }
    viewer.addOnceHandler('open', onOpen)
    return () => {
      viewer.removeHandler('open', onOpen)
      cancelAnimationFrame(raf)
      timeouts.forEach(clearTimeout)
    }
  }, [imgSrc])

  // Redraw quand le conteneur change de taille (poignées de redimensionnement).
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => viewerRef.current?.forceRedraw())
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !page) return
    const apply = () => {
      viewer.clearOverlays()
      for (const seg of page.segments) {
        const box = bboxRect(seg.bbox)
        if (!box) continue
        const el = document.createElement('div')
        el.className = 'seg-overlay' + (seg.id === activeSegmentId ? ' seg-active' : '')
        const rect = viewer.viewport.imageToViewportRectangle(box[0], box[1], box[2], box[3])
        viewer.addOverlay(el, rect)
      }
    }
    if (viewer.world.getItemCount() > 0) apply()
    else viewer.addOnceHandler('open', apply)
  }, [page?.id, page?.segments, imgSrc, activeSegmentId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !activeSegmentId || !page || viewer.world.getItemCount() === 0) return
    const seg = page.segments.find((s) => s.id === activeSegmentId)
    const box = seg && bboxRect(seg.bbox)
    if (box) {
      const rect = viewer.viewport.imageToViewportRectangle(
        box[0] - 30, box[1] - 30, box[2] + 60, box[3] + 60)
      viewer.viewport.fitBounds(rect, true)
    }
  }, [activeSegmentId])

  return (
    <section className="flex flex-col min-h-0 shrink-0" style={{ width: `${widthPct * 100}%` }}>
      <div className="px-3 py-2 border-b bg-card flex items-center gap-2 shrink-0">
        <h3 className="font-display text-sm font-semibold">Image source</h3>
        {page && <span className="text-[11px] text-muted-foreground">page {page.page_number}</span>}
      </div>
      <div className="flex-1 relative osd-host min-h-0">
        <div ref={containerRef} className="absolute inset-0 osd-host" />
        {!imgSrc && (
          <div className="absolute inset-0 flex items-center justify-center text-paper-2/60 text-sm pointer-events-none">
            {page ? (imageError ? 'Image indisponible' : 'Chargement…') : 'Aucune page sélectionnée'}
          </div>
        )}
        <div className="absolute bottom-2 left-2 bg-ink/60 text-paper text-xs rounded px-2 py-1 pointer-events-none">
          🔍 {zoomLabel}%
        </div>
      </div>
      <div className="bg-card border-t shrink-0">
        <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pages
        </div>
        <div className="h-20 flex gap-2 p-2 pt-1 overflow-x-auto thin-scroll">
        {pages.map((p) => (
          <button key={p.id} onClick={() => onSelect(p.id)}
                  className={`min-w-14 h-full rounded border text-[10px] relative
                              ${page?.id === p.id ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}>
            <span className="absolute bottom-0 right-1 bg-ink/70 text-paper rounded px-1">
              {p.page_number}
            </span>
            <StatusDot status={p.processing_status} />
          </button>
        ))}
        </div>
      </div>
    </section>
  )
}

function bboxRect(bbox: any): [number, number, number, number] | null {
  if (!bbox) return null
  try {
    if (bbox.type === 'bbox' && Array.isArray(bbox.box)) {
      const [x0, y0, x1, y1] = bbox.box.map(Number)
      return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]
    }
    const poly: [number, number][] = bbox.type === 'baseline'
      ? (bbox.baseline || []).map((p: any) => [Number(p[0]), Number(p[1])])
      : (bbox.boundary || []).map((p: any) => [Number(p[0]), Number(p[1])])
    if (!poly.length) return null
    const xs = poly.map((p) => p[0])
    const ys = poly.map((p) => p[1])
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    return [minX, minY, maxX - minX, maxY - minY]
  } catch {
    return null
  }
}

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    done: 'bg-success', error: 'bg-destructive', transcribing: 'bg-primary animate-pulse',
    queued: 'bg-warning', idle: 'bg-border',
  }
  return <span className={`absolute top-1 left-1 w-2 h-2 rounded-full ${color[status] || 'bg-border'}`} />
}
