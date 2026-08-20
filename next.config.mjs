/** @type {import('next').NextConfig} */
const nextConfig = {
  // Temporary: minified production error codes have been impossible
  // to pin down from stack traces alone. Remove once the Discovery
  // Search client crash is diagnosed and fixed.
  productionBrowserSourceMaps: true,
};
export default nextConfig;
