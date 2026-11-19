import QRCode from 'qrcode';

const QR_OPTIONS = {
  width: 256,
  margin: 2,
  errorCorrectionLevel: 'M',
};

/**
 * Generate a QR code as a PNG data URL for a given short URL
 * @param {string} shortUrl - The full short URL (e.g., https://agh3.me/xyz123)
 * @returns {Promise<string|null>} - QR code as PNG data URL
 */
export async function generateQrCode(shortUrl) {
  try {
    return await QRCode.toDataURL(shortUrl, QR_OPTIONS);
  } catch (error) {
    console.error(`Failed to generate QR code for ${shortUrl}:`, error);
    return null;
  }
}

/**
 * Generate a QR code as an SVG document
 * @param {string} shortUrl - The full short URL (e.g., https://agh3.me/xyz123)
 * @returns {Promise<string|null>} - QR code as SVG markup
 */
export async function generateQrSvg(shortUrl) {
  try {
    return await QRCode.toString(shortUrl, { ...QR_OPTIONS, type: 'svg' });
  } catch (error) {
    console.error(`Failed to generate QR SVG for ${shortUrl}:`, error);
    return null;
  }
}
