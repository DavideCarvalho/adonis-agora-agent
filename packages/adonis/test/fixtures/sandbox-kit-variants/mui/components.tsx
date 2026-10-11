import { styled } from '@mui/material/styles';

export { Button, Card, CardContent, Menu, MenuItem, Stack, Typography } from '@mui/material';

/** A price, in the theme's primary color. */
export const PriceTag = styled('span')(({ theme }) => ({
  color: theme.palette.primary.main,
  fontWeight: 700,
}));
