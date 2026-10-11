import type { ButtonHTMLAttributes } from 'react';

/** A button in the app's style. */
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`bg-primary text-primary-foreground rounded-lg px-3 py-1 ${className}`}
      {...props}
    />
  );
}
