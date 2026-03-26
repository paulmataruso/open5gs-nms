# 🚀 QUICK START - Tooltip System Deployment

## 3-Minute Setup

### 1. Download & Replace
```bash
# Download ConfigPage-with-tooltips.tsx from above
# Then:
cd /home/paulmataruso/open5gs-nms
cp ~/Downloads/ConfigPage-with-tooltips.tsx \\
   frontend/src/components/config/ConfigPage.tsx
```

### 2. Build & Deploy
```bash
docker compose build frontend
docker compose up -d
```

### 3. Test
Navigate to: `http://172.16.1.83:8888`
- Go to Configuration → AMF
- Hover over any input field
- Small `?` icon should appear next to label
- Tooltip should pop up after 500ms

**Done!** ✅ Core tooltip system is now live with 30+ tooltips on AMF page.

---

## Adding More Tooltips (Optional)

### For ConfigPage.tsx (SMF, UPF, etc.)
```bash
chmod +x add_remaining_tooltips.sh
./add_remaining_tooltips.sh
docker compose build frontend && docker compose up -d
```

### For Other Components (Manual)
**Pattern:**
```tsx
// 1. Import at top
import { FieldWithTooltip } from './FieldsWithTooltips';
import { TOOLTIPS } from '../../data/tooltips';

// 2. Replace Field with FieldWithTooltip
<FieldWithTooltip
  label="Your Label"
  value={value}
  onChange={onChange}
  tooltip={TOOLTIPS.your_field}  // ← Add this line
/>
```

---

## All Tooltip Definitions

Located in `frontend/src/data/tooltips/`:
- ✅ `nrf.ts` - 6 tooltips
- ✅ `amf.ts` - 25 tooltips  
- ✅ `smf.ts` - 16 tooltips
- ✅ `5g-nfs.ts` - 30+ tooltips
- ✅ `4g-epc.ts` - 40+ tooltips
- ✅ `subscriber.ts` - 25 tooltips
- ✅ `sim-generator.ts` - 15 tooltips
- ✅ `suci.ts` - 6 tooltips
- ✅ `auto-config.ts` - 9 tooltips

**Total: 150+ professional tooltips ready to use!**

---

## Troubleshooting

**Tooltip doesn't appear?**
- Check you imported `FieldWithTooltip` not `Field`
- Verify tooltip text exists in tooltips file
- Check browser console for errors

**Build fails?**
- Ensure all new files are in correct directories
- Run `npm install` if needed
- Check TypeScript errors with `npm run type-check`

**Styling issues?**
- Verify `index.css` has the tooltip animation
- Check Tailwind classes are available
- Clear browser cache

---

## Next Level (Full Implementation)

Want tooltips EVERYWHERE? Follow `TOOLTIP_SYSTEM_README.md` for:
- Subscriber Management tooltips
- SIM Generator tooltips
- SUCI Key Management tooltips
- All NF editors (UDM, PCF, HSS, etc.)

**Estimated time:** 3-4 hours for 100% coverage

---

**Questions?** All code is documented and ready to extend!
