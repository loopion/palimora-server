import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LegalPage from './LegalPage'

test('renders every section heading for the given namespace', () => {
  render(
    <MemoryRouter initialEntries={['/confidentialite']}>
      <LegalPage namespace="privacy" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1, name: /Politique de confidentialité/i })).toBeInTheDocument()
  expect(screen.getByText('Responsable du traitement')).toBeInTheDocument()
  expect(screen.getByText('Vos droits')).toBeInTheDocument()
})

test('renders the terms namespace on the same component', () => {
  render(
    <MemoryRouter initialEntries={['/cgu']}>
      <LegalPage namespace="terms" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1, name: /Conditions générales/i })).toBeInTheDocument()
  expect(screen.getByText('Droit applicable')).toBeInTheDocument()
})
