import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * How the button looks.
   * @default "default"
   */
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  /** Its size. */
  size?: 'sm' | 'md' | 'lg';
}

/** A button in the app's style. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      data-variant={variant}
      className={cn('btn', `btn-${variant}`, `btn-${size}`, className)}
      {...props}
    />
  );
});

/** Not a component: a helper. */
export const buttonClasses = (variant: string) => `btn btn-${variant}`;
