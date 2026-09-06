import { render, screen } from '@testing-library/react'
import Mark from './Mark'

test('renders an accessible svg mark', () => {
  render(<Mark />)
  const svg = screen.getByRole('img', { name: 'Palimora' })
  expect(svg.tagName.toLowerCase()).toBe('svg')
})

test('applies the requested size', () => {
  render(<Mark size={32} />)
  const svg = screen.getByRole('img', { name: 'Palimora' })
  expect(svg).toHaveAttribute('width', '32')
  expect(svg).toHaveAttribute('height', '32')
})
