import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useEffect } from 'react'
import { usePrompt } from './PromptModal'

function Harness({ onResult }: { onResult: (v: string | null) => void }) {
  const { prompt, node } = usePrompt()
  useEffect(() => { prompt({ title: 'Titre ?' }).then(onResult) }, [])
  return <>{node}</>
}

test('resolves with the typed value', async () => {
  let result: string | null | undefined
  render(<Harness onResult={(v) => { result = v }} />)
  const input = await screen.findByRole('textbox')
  fireEvent.change(input, { target: { value: 'Liste Augustin' } })
  fireEvent.click(screen.getByText('Valider'))
  await waitFor(() => expect(result).toBe('Liste Augustin'))
})

test('resolves null on cancel', async () => {
  let result: string | null | undefined = 'x'
  render(<Harness onResult={(v) => { result = v }} />)
  await screen.findByRole('textbox')
  fireEvent.click(screen.getByText('Annuler'))
  await waitFor(() => expect(result).toBeNull())
})
