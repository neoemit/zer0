import QRCode from 'qrcode';

/**
 * Generate a QR code as a PNG data URL for a given short URL
 * @param {string} shortUrl - The full short URL (e.g., https://agh3.me/xyz123)
 * @returns {Promise<string>} - QR code as PNG data URL
 */
export async function generateQrCode(shortUrl) {
  try {
    return await QRCode.toDataURL(shortUrl, {
      width: 128,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
  } catch (error) {
    console.error(`Failed to generate QR code for ${shortUrl}:`, error);
    return null;
  }
}
