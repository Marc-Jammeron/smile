# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

# Workspace package.json files only, to cache the npm ci layer independently
# of source changes. npm workspaces need every workspace listed in the root
# package.json to be present, even ones this image doesn't build.
COPY package.json package-lock.json ./
COPY front-shared/package.json front-shared/package.json
COPY front-admin/package.json front-admin/package.json
COPY front-client/package.json front-client/package.json
RUN npm ci

COPY front-shared front-shared
COPY front-admin front-admin

# Vite inlines VITE_* vars at build time, so they must be supplied as
# build args (baked into the static bundle), not as container runtime env.
ARG VITE_API_BASE_URL
ARG VITE_CLIENT_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_CLIENT_BASE_URL=$VITE_CLIENT_BASE_URL

RUN npm run build --workspace=front-admin

FROM nginx:alpine AS runtime

COPY front-admin/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/front-admin/dist /usr/share/nginx/html

# Scaleway Serverless Containers injects PORT at runtime; nginx's entrypoint
# envsubst's templates/*.template into conf.d, so no custom entrypoint needed.
ENV PORT=8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
