import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import About from './About'

test('renders the about copy and a mailto contact link', () => {
  render(<MemoryRouter initialEntries={['/a-propos']}><About /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: 'Pourquoi Palimora' })).toBeInTheDocument()
  const link = screen.getByRole('link', { name: /contact@palimora\.fr/ })
  expect(link).toHaveAttribute('href', 'mailto:contact@palimora.fr')
})

test('renders the english about copy on /en/about', () => {
  render(<MemoryRouter initialEntries={['/en/about']}><About /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: 'Why Palimora' })).toBeInTheDocument()
  expect(screen.getByText(/A question, or an institutional use case\?/)).toBeInTheDocument()
})
