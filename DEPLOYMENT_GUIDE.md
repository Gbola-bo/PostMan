# Deploying (GitHub Pages)

Simpler than the Next.js/Vercel flow - no build step at all, just static
files being served as-is.

## First time setup

1. Create a new repository on github.com (or reuse the one from the
   Next.js version - up to you).
2. Get this folder's contents into that repository:
   - **GitHub Desktop**: File -> Add Local Repository -> pick this folder
     -> Publish repository.
   - **Command line**:
     ```
     cd path/to/postman-static
     git init
     git add .
     git commit -m "Initial commit"
     git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
     git push -u origin main
     ```
3. On GitHub, go to the repository's **Settings -> Pages**.
4. Under "Build and deployment", set Source to **Deploy from a branch**,
   branch **main**, folder **/ (root)**. Save.
5. Wait about a minute, then refresh that same Pages settings screen - it
   shows the live URL, something like
   `https://your-username.github.io/your-repo/`.

That's the whole setup. No build configuration, no environment variables,
nothing else to connect.

## Making changes later

Same as before, just without a separate hosting service to think about:
push to `main`, GitHub Pages picks it up automatically, live again within
a minute or two. Check the repository's "Actions" tab if you want to watch
a deployment happen.

## Adding a new template (the part you'll do most often)

This is a normal file change, not a special deployment step:
1. Run `vet.html` locally, get the manifest entry (see `README.md`).
2. Add the `.psd` file and the manifest entry to this repo.
3. Commit and push, same as any other change.

## A note on file size

GitHub is fine with files up to 50MB without any special setup (warns
above that, hard-blocks at 100MB without Git LFS). The PSDs tested in this
project were around 10-15MB, comfortably under that - this isn't expected
to be an issue, but if a future template is unusually large, that's the
number to know about.

## Custom domain (optional)

Same idea as the Vercel version: buy a domain anywhere, then in the same
Settings -> Pages screen, enter it under "Custom domain" and follow the DNS
instructions GitHub shows you.
