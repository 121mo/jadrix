"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function safeFilePath(requestUrl) {
  const pathname = decodeURIComponent(
    new URL(requestUrl, "http://localhost").pathname
  );

  const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalizedPath = path.normalize(requestedFile);
  const fullPath = path.resolve(PUBLIC_DIR, normalizedPath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return fullPath;
}

const server = http.createServer((request, response) => {
  const filePath = safeFilePath(request.url);

  if (!filePath) {
    response.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("غير مسموح");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end("الصفحة غير موجودة");
      return;
    }

    fs.readFile(filePath, (readError, content) => {
      if (readError) {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        response.end("حدث خطأ في الخادم");
        return;
      }

      const extension = path.extname(filePath).toLowerCase();

      response.writeHead(200, {
        "Content-Type":
          mimeTypes[extension] || "application/octet-stream",
        "Cache-Control": "no-store"
      });

      response.end(content);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Jadrix is running on port ${PORT}`);
});
