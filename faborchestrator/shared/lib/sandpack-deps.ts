// Dependency detection for Sandpack React artifact previews
// Parses import statements and maps to known npm packages with pinned versions

// Known npm packages that Claude commonly generates in React artifacts
const KNOWN_PACKAGES: Record<string, string> = {
  // Charting
  'recharts': '2.15.3',
  'd3': '7.9.0',
  'chart.js': '4.4.9',
  'react-chartjs-2': '5.3.0',
  'victory': '37.3.6',
  'nivo': '0.88.0',
  '@nivo/core': '0.88.0',
  '@nivo/bar': '0.88.0',
  '@nivo/line': '0.88.0',
  '@nivo/pie': '0.88.0',
  // Animation
  'framer-motion': '12.6.5',
  'motion': '12.6.5',
  'react-spring': '9.7.7',
  '@react-spring/web': '9.7.7',
  'gsap': '3.12.7',
  // State management
  'zustand': '5.0.5',
  'immer': '10.1.1',
  'use-immer': '0.11.0',
  'jotai': '2.12.3',
  'valtio': '2.1.2',
  // UI libraries
  'lucide-react': '0.473.0',
  'react-icons': '5.5.0',
  '@heroicons/react': '2.2.0',
  '@radix-ui/react-icons': '1.3.2',
  '@radix-ui/react-dialog': '1.1.4',
  '@radix-ui/react-dropdown-menu': '2.1.6',
  '@radix-ui/react-tooltip': '1.1.6',
  '@radix-ui/react-switch': '1.1.3',
  '@radix-ui/react-slider': '1.2.3',
  '@radix-ui/react-tabs': '1.1.3',
  '@radix-ui/react-accordion': '1.2.3',
  '@radix-ui/react-select': '2.1.6',
  '@radix-ui/react-popover': '1.1.6',
  '@radix-ui/react-checkbox': '1.1.4',
  // Utilities
  'lodash': '4.17.21',
  'date-fns': '4.1.0',
  'dayjs': '1.11.13',
  'clsx': '2.1.1',
  'class-variance-authority': '0.7.1',
  'tailwind-merge': '2.6.0',
  'uuid': '11.1.0',
  'nanoid': '5.1.5',
  // Forms
  'react-hook-form': '7.55.0',
  'zod': '3.24.4',
  '@hookform/resolvers': '4.1.3',
  // HTTP
  'axios': '1.9.0',
  'swr': '2.3.3',
  '@tanstack/react-query': '5.75.5',
  // Math / data
  'mathjs': '14.3.1',
  'papaparse': '5.5.2',
  // Markdown
  'react-markdown': '10.1.0',
  'marked': '15.0.7',
  'remark-gfm': '4.0.1',
  // Syntax highlighting
  'prismjs': '1.30.0',
  'highlight.js': '11.11.1',
  'react-syntax-highlighter': '15.6.1',
  // Maps
  'leaflet': '1.9.4',
  'react-leaflet': '5.0.0',
  // Three.js
  'three': '0.175.0',
  '@react-three/fiber': '9.1.2',
  '@react-three/drei': '10.0.7',
  // Misc
  'react-use': '17.6.0',
  'react-hot-toast': '2.5.2',
  'sonner': '2.0.3',
  'react-confetti': '6.2.2',
  '@dnd-kit/core': '6.3.1',
  '@dnd-kit/sortable': '10.0.0',
  'react-beautiful-dnd': '13.1.1',
  'react-color': '2.19.3',
  'react-select': '5.9.0',
  'react-table': '7.8.0',
  '@tanstack/react-table': '8.21.3',
  'react-virtualized': '9.22.5',
  'react-window': '1.8.11',
  'react-router-dom': '7.5.0',
  'qrcode.react': '4.2.0',
  'react-pdf': '9.2.1',
  'html2canvas': '1.4.1',
  'canvas-confetti': '1.9.3',
  'lottie-react': '2.4.0',
  'embla-carousel-react': '8.6.0',
  'cmdk': '1.1.1',
}

// Regex to match import statements
// Handles: import x from 'y', import { x } from 'y', import 'y', import * as x from 'y'
const IMPORT_RE = /import\s+(?:(?:\*\s+as\s+\w+|\{[^}]*\}|[\w$]+)(?:\s*,\s*(?:\{[^}]*\}|[\w$]+))*\s+from\s+)?['"]([^'"./][^'"]*)['"]/g

/**
 * Given source code, return a dependencies object for Sandpack's customSetup.
 * Only includes packages we have pinned versions for.
 * Also checks the full import specifier (e.g., 'motion/react') as a known package.
 */
export function detectDependencies(code: string): Record<string, string> {
  const deps: Record<string, string> = {}
  const re = new RegExp(IMPORT_RE.source, 'g')
  let match: RegExpExecArray | null

  while ((match = re.exec(code)) !== null) {
    const specifier = match[1]

    // Check full specifier first (e.g., 'motion/react')
    if (KNOWN_PACKAGES[specifier]) {
      deps[specifier] = KNOWN_PACKAGES[specifier]
      continue
    }

    // Extract package name
    let packageName: string
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/')
      packageName = parts.slice(0, 2).join('/')
    } else {
      packageName = specifier.split('/')[0]
    }

    if (KNOWN_PACKAGES[packageName]) {
      deps[packageName] = KNOWN_PACKAGES[packageName]
    }
  }

  return deps
}

/**
 * Detect if the code uses TypeScript syntax.
 */
export function detectTypeScript(code: string): boolean {
  const tsPatterns = [
    /:\s*(?:string|number|boolean|void|any|never|unknown)\b/,
    /interface\s+\w+/,
    /type\s+\w+\s*=/,
    /<\w+(?:\s*,\s*\w+)*>(?:\s*\(|\s*\{)/,
    /as\s+(?:string|number|boolean|const|any)\b/,
    /:\s*React\.\w+/,
    /:\s*(?:FC|FunctionComponent|ComponentProps|PropsWithChildren)\b/,
  ]
  return tsPatterns.some((p) => p.test(code))
}
