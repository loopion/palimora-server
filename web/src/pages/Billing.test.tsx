import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi, afterEach } from 'vitest'
import { api } from '../api'
import Billing from './Billing'

afterEach(() => vi.restoreAllMocks())

test('renders the catalogue packs', async () => {
  vi.spyOn(api.billing, 'catalogue').mockResolvedValue({
    enabled: true, publishable_key: 'pk_test',
    packs: [
      { id: 'starter', kind: 'one_shot', credits: 300, amount_eur: 29, price_per_page: 0.097, label: 'Starter', stripe_price_id: 'price_s' },
      { id: 'atelier', kind: 'subscription', credits: 500, amount_eur: 39, price_per_page: 0.078, label: 'Atelier', stripe_price_id: 'price_a', interval: 'month' },
    ],
  })
  vi.spyOn(api.billing, 'status').mockResolvedValue(
    { credit_balance: 12, subscription: null, purchases: [] })
  render(<MemoryRouter><Billing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Starter')).toBeTruthy())
  expect(screen.getByText('Atelier')).toBeTruthy()
  expect(screen.getByText(/12/)).toBeTruthy()
})

test('shows disabled notice when billing is off', async () => {
  vi.spyOn(api.billing, 'catalogue').mockResolvedValue(
    { enabled: false, publishable_key: '', packs: [] })
  vi.spyOn(api.billing, 'status').mockResolvedValue(
    { credit_balance: 0, subscription: null, purchases: [] })
  render(<MemoryRouter><Billing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/indisponible/i)).toBeTruthy())
})
