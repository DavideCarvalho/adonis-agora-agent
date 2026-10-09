import type * as React from 'react';
import { cn } from '@/lib/utils';

/** A surface that groups related content. */
export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('card', className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('card-header', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('card-title', className)} {...props} />;
}
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('card-content', className)} {...props} />;
}
