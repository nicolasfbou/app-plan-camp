import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addObject } from '@/domain/model/operations.ts';
import { planStore } from '@/store/planStore.ts';
import { makeDocument, makeZone } from '@/test/fixtures.ts';
import { TopBar } from './TopBar.tsx';

afterEach(() => act(() => planStore.getState().load(null)));

describe('barre supérieure', () => {
  it('sans plan : annuler et rétablir sont désactivés, aucun statut de sauvegarde', () => {
    render(<TopBar />);
    expect(screen.getByText('Aucun plan ouvert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Annuler/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Rétablir/ })).toBeDisabled();
    expect(screen.queryByTestId('save-status')).toBeNull();
  });

  it('reflète l’historique réel et l’état de sauvegarde', () => {
    const doc = makeDocument();
    act(() => planStore.getState().load(doc));
    render(<TopBar />);
    expect(screen.getByTestId('plan-title')).toHaveTextContent('Plan général');
    expect(screen.getByTestId('save-status')).toHaveTextContent('Enregistré');

    act(() => planStore.getState().update('ajout', (d) => addObject(d, makeZone(doc.layers[0]!.id))));
    expect(screen.getByTestId('save-status')).toHaveTextContent('Modifications non enregistrées');
    const undo = screen.getByRole('button', { name: /Annuler/ });
    expect(undo).toBeEnabled();

    fireEvent.click(undo);
    expect(Object.keys(planStore.getState().doc!.objects)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Rétablir/ })).toBeEnabled();
  });
});
