import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import PublicLayout from './PublicLayout'

vi.mock('../../api', () => ({ getToken: vi.fn() }))
import { getToken } from '../../api'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<div>home fr</div>} />
          <Route path="/en" element={<div>home en</div>} />
          <Route path="/tarifs" element={<div>pricing fr</div>} />
        </Route>
        <Route path="/station" element={<div>station</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

test('anonymous visitor sees the homepage', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/')
  expect(screen.getByText('home fr')).toBeInTheDocument()
})

test('authed visitor on the homepage is redirected to /station', () => {
  vi.mocked(getToken).mockReturnValue('tok')
  renderAt('/')
  expect(screen.getByText('station')).toBeInTheDocument()
})

test('authed visitor on a non-homepage public page is not redirected', () => {
  vi.mocked(getToken).mockReturnValue('tok')
  renderAt('/tarifs')
  expect(screen.getByText('pricing fr')).toBeInTheDocument()
})

test('renders the language toggle pointing at the route pair', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/tarifs')
  const toggle = screen.getByRole('link', { name: /switch to english/i })
  expect(toggle).toHaveAttribute('href', '/en/pricing')
})
