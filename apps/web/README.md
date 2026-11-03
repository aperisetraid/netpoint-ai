# NetPoint AI Web

## Inspeccion del fotograma

La seccion Fotograma actual, dentro de Ingesta, muestra la imagen del video
descargado cuando el reproductor esta pausado. Las capas Pista, Jugadores y
Pelota muestran la calibracion y las detecciones guardadas de ese fotograma;
no ejecutan una nueva inferencia. Las cajas discontinuas indican posiciones
de jugadores reutilizadas de fotogramas anteriores.

El navegador consulta las imagenes al servicio de vision en
`http://localhost:8000`. Para usar otra direccion, configura
`VITE_VISION_BASE_URL` y reinicia Vite. La API de telemetria sigue usando
`VITE_API_BASE_URL` (por defecto `http://localhost:3000`).

El servicio de vision ofrece `GET /matches/{matchId}/frames/{frame_index}`
como imagen JPEG. Los videos se guardan en `temp/matches` del servicio de
vision; su registro es temporal en memoria. Tras reiniciar el servicio o
para resultados anteriores sin metadatos de imagen, vuelve a analizar el
video. Durante la reproduccion no se solicitan imagenes del inspector.

## React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
