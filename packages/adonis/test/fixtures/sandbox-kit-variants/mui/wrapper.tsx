import CssBaseline from '@mui/material/CssBaseline';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';

const theme = createTheme({
  palette: { primary: { main: '#00897b' }, background: { default: '#fffbea' } },
  shape: { borderRadius: 14 },
  typography: { fontFamily: 'Georgia, serif' },
});

export default function Wrapper({ children }: { children?: ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
