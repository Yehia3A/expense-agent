// Vite raw imports (e.g. migration SQL in the eval runner).
declare module "*?raw" {
  const content: string;
  export default content;
}
