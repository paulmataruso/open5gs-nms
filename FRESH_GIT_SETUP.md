# Fresh Git Setup - Quick Start

You've removed the old .git folder and created a new blank repository on Gitea.
Here's how to push everything fresh.

---

## Quick Start (Automated)

### Windows Command Prompt:
```cmd
cd /d "G:\Claude_Workspace\Working\open5gs-nms"
fresh-git-setup.bat
```

### Git Bash or PowerShell:
```bash
cd "G:\Claude_Workspace\Working\open5gs-nms"
bash fresh-git-setup.sh
```

---

## Manual Commands (Step by Step)

If you prefer to do it manually, here are the exact commands:

```bash
# Navigate to project
cd "G:\Claude_Workspace\Working\open5gs-nms"

# 1. Initialize new git repository
git init

# 2. Add Gitea as remote
git remote add origin http://git.dhitechnical.com/paulmataruso/open5gs-nms.git

# 3. Configure git user (optional, if not set globally)
git config user.name "Paul Mataruso"
git config user.email "paul@dhitechnical.com"

# 4. Add all files
git add .

# 5. Check what will be committed
git status

# 6. Create initial commit
git commit -m "Initial commit: Open5GS NMS v1.0.0

Complete network management system for Open5GS 5G Core and 4G EPC.

Features:
- Complete 16 NF configuration management
- Network topology visualization
- Subscriber management with auto-provisioning
- SUCI key management for 5G privacy
- Service management with systemd integration
- Auto-configuration wizard
- Real-time logging and monitoring
- Backup & restore with rollback
- 150+ tooltips throughout UI

Documentation:
- Comprehensive README with screenshots
- Complete installation guide
- Architecture documentation
- Full docs/ directory (9 files)

Technology: React 18, TypeScript, Node.js 20, Docker
License: MIT"

# 7. Create v1.0.0 tag
git tag -a v1.0.0 -m "Release v1.0.0 - Production-ready Open5GS NMS"

# 8. Push to Gitea
git push -u origin main
# or if your default branch is master:
# git push -u origin master

# 9. Push the tag
git push origin v1.0.0
```

---

## What Gets Pushed

Everything in your project:
- ✅ README.md with all 12 screenshots
- ✅ CHANGELOG.md
- ✅ INSTALL.md
- ✅ ARCHITECTURE.md
- ✅ CONTRIBUTING.md
- ✅ LICENSE (MIT)
- ✅ .gitignore, .dockerignore, .env.example
- ✅ Complete docs/ directory (9 documentation files)
- ✅ All 12 screenshots in docs/screenshots/
- ✅ backend/ - Complete Node.js backend source
- ✅ frontend/ - Complete React frontend source
- ✅ nginx/ - nginx configuration
- ✅ docker-compose.yml

---

## After Pushing Successfully

1. **Verify on Gitea:**
   Visit: http://git.dhitechnical.com/paulmataruso/open5gs-nms
   
2. **Check everything is there:**
   - All folders visible (backend, frontend, nginx, docs)
   - README displays properly with images
   - Commit message shows "Initial commit: Open5GS NMS v1.0.0"
   - Tag v1.0.0 appears

3. **Create a Release:**
   - In Gitea, go to "Releases" → "New Release"
   - Select tag: v1.0.0
   - Title: "Open5GS NMS v1.0.0"
   - Description: Copy content from CHANGELOG.md
   - Click "Publish Release"

---

## Troubleshooting

### If you get "remote origin already exists":
```bash
git remote remove origin
git remote add origin http://git.dhitechnical.com/paulmataruso/open5gs-nms.git
```

### If git asks for credentials:
Enter your Gitea username and password when prompted.

### If you want to use SSH instead of HTTP:
```bash
git remote set-url origin git@git.dhitechnical.com:paulmataruso/open5gs-nms.git
```

### If push fails with authentication error:
```bash
# Use credential helper to store password
git config --global credential.helper store
# Then push again (will prompt once for password)
git push -u origin main
```

---

## That's it!

Your fresh Open5GS NMS v1.0.0 repository is ready! 🎉
