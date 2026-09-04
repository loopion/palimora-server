import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Home from './Home'

test('renders the french hero by default', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /100 pages offertes/i })).toHaveAttribute('href', '/register')
})

test('renders the english hero on /en', () => {
  render(<MemoryRouter initialEntries={['/en']}><Home /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: /story to tell/i })).toBeInTheDocument()
})

test('renders all three how-it-works steps', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByText('Déposez')).toBeInTheDocument()
  expect(screen.getByText('Transcription')).toBeInTheDocument()
  expect(screen.getByText('Corrigez et exportez')).toBeInTheDocument()
})

test('renders the honest stat-slot label instead of a fabricated number', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByText(/mesures publiées prochainement/i)).toBeInTheDocument()
})
