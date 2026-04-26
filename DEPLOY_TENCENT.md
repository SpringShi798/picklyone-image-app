# Tencent Cloud Deployment

This project is ready to run on a Tencent Cloud CVM or Lighthouse server.

## Recommended stack

- Ubuntu 22.04
- Node.js 20
- PM2
- Nginx

## 1. Install runtime

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2
```

## 2. Upload project

```bash
rsync -avz ./ user@YOUR_SERVER_IP:/home/user/picklyone-image-app/
```

## 3. Configure environment

```bash
cd /home/user/picklyone-image-app
cp .env.example .env
```

Edit `.env` and set `PICKLYONE_API_KEY`.
If your key only has access to a specific image model, also set `PICKLYONE_IMAGE_MODEL`.

## 4. Start the app

```bash
set -a
source .env
set +a
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 5. Configure Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/picklyone-image-app.conf
sudo ln -sf /etc/nginx/sites-available/picklyone-image-app.conf /etc/nginx/sites-enabled/picklyone-image-app.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Verify

```bash
curl http://127.0.0.1:3000/healthz
curl http://YOUR_SERVER_IP/healthz
```

Open `http://YOUR_SERVER_IP/` in the browser.

## Important

If `/v1/models` for your key does not list any image model, image generation will fail with `MODEL_ACCESS_DENIED`.
