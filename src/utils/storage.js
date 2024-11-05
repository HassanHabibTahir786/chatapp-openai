import fs from "fs";
import path from "path";
import { fileURLToPath } from "url"; 
const __filename = fileURLToPath(import.meta.url); 
const __dirname = path.dirname(__filename);
import os from 'os';
//development
export const getStoragePath = (file) => {
  const storagePath = path.join(__dirname, '../', 'storage', file.name);
  const directory = path.dirname(storagePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return storagePath;
};


//production
// export const getStoragePath = (file) => {
//   const tempDir = os.tmpdir();
//   const storagePath = path.join(tempDir, file.name);
//   return storagePath;
// };

// fet file
export const getStoreFile = (name) => {
    const fullPath =  path.join(__dirname, '../storage', name);
    return [fullPath]
  };