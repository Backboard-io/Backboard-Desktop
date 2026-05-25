import './globals.css';

export const metadata = {
  title: 'Backboard Studio',
  description: 'Download Backboard Studio for macOS.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
