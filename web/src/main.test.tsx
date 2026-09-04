// web/src/main.tsx
// Route-table smoke test: renders the same tree main.tsx builds, at a
// couple of key paths, without touching the DOM entry point.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

vi.mock('./api', () => ({ getToken: vi.fn(() => null) }))

import PublicLayout from './components/public/PublicLayout'
import Home from './pages/public/Home'
import Pricing from './pages/public/Pricing'

function Tree({ initialPath }: { initialPath: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/en" element={<Home />} />
          <Route path="/tarifs" element={<Pricing />} />
        </Route>
        <Route path="/station" element={<div>station</div>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MemoryRouter>
  )
}

test('root path renders the homepage', () => {
  render(<Tree initialPath="/" />)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})

test('unknown path falls back to the homepage', () => {
  render(<Tree initialPath="/nope" />)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})
