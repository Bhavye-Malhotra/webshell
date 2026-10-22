/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // node-pty and ws are only used in the custom server (server.js), not bundled
  serverExternalPackages: ['node-pty', 'ws'],
};

export default nextConfig;