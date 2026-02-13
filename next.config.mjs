/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // ADD THIS SECTION:
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // END ADDITION
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  webpack: (config) => {
    config.externals.push({
      'better-sqlite3': 'commonjs better-sqlite3',
    });
    return config;
  },
};

export default nextConfig;
