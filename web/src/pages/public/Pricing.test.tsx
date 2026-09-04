import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import Pricing from './Pricing'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return { ...actual, api: { ...actual.api, billing: { catalogue: vi.fn() } } }
})
import { api } from '../../api'

test('shows a loading state then the packs from the catalogue', async () => {
  vi.mocked(api.billing.catalogue).mockResolvedValue({
    packs: [
      { id: 'starter', kind: 'one_shot', credits: 300, amount_eur: 29, price_per_page: 0.0967, label: 'Starter', stripe_price_id: '' },
    ],
    publishable_key: '',
    enabled: true,
  })
  render(<MemoryRouter initialEntries={['/tarifs']}><Pricing /></MemoryRouter>)
  expect(screen.getByText('Chargement des tarifs…')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument())
  expect(screen.getByText(/300/)).toBeInTheDocument()
})

test('shows an error state if the catalogue fails to load', async () => {
  vi.mocked(api.billing.catalogue).mockRejectedValue(new Error('network'))
  render(<MemoryRouter initialEntries={['/tarifs']}><Pricing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/momentanément indisponibles/i)).toBeInTheDocument())
})
