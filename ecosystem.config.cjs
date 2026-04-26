module.exports = {
  apps: [
    {
      name: "picklyone-image-app",
      script: "./server.js",
      env: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: "3000",
        PICKLYONE_IMAGE_MODEL: "gpt-image-2",
      },
    },
  ],
};
