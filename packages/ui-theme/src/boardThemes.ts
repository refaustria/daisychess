export interface BoardTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const DEFAULT_BOARD_THEME = 'brown';

export const boardThemes: readonly BoardTheme[] = [
  { id: 'brown', name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  { id: 'blue', name: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
  { id: 'green', name: 'Green', light: '#ffffdd', dark: '#86a666' },
  { id: 'purple', name: 'Purple', light: '#f0f1f0', dark: '#8476ba' },
  { id: 'wood', name: 'Wood', light: '#e8c99b', dark: '#a67a4f' },
  { id: 'grey', name: 'Grey', light: '#dcdcdc', dark: '#7f7f7f' },
];

export function findBoardTheme(id: string): BoardTheme | undefined {
  return boardThemes.find((t) => t.id === id);
}
