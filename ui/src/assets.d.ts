// Bun's bundler turns an imported asset into its hashed URL (/assets/name-hash.ext).
declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*.css";
