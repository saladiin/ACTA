# GitHub Migration Notes

This folder is a clean migration copy of the current working game files from the nested project folder.

Private local files such as `B5.env`, `postgres-local-admin-password.txt`, `.local`, `.local-dev`, `node_modules`, and log files were intentionally left out of Git tracking.

Large binary assets are configured for Git LFS in `.gitattributes`. Install Git LFS before pushing:

```powershell
git lfs install
```

Suggested first push after creating a GitHub repository:

```powershell
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

Use a private GitHub repository if the model, rulebook, or reference assets should not be public.
