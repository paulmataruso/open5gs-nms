#!/bin/bash
# Text Editor Build Script

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Building Open5GS NMS with Text Editor Feature            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Change to project directory
cd G:/Claude_Workspace/Working/open5gs-nms

echo "📋 Files changed:"
echo "  - frontend/package.json (added yaml + monaco)"
echo "  - frontend/src/components/config/ConfigPage.tsx (added toggle)"
echo "  - frontend/src/components/config/YamlTextEditor.tsx (NEW)"
echo ""

echo "🔨 Building frontend container..."
docker-compose build frontend

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo ""
    echo "🔄 Restarting frontend container..."
    docker-compose restart frontend
    
    echo ""
    echo "✅ Restart complete!"
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║  ✅ TEXT EDITOR DEPLOYED                                   ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "📝 Test Checklist:"
    echo "  1. Open Configuration page"
    echo "  2. Verify 'Form Editor' button selected (default)"
    echo "  3. Test form editing (should work exactly as before)"
    echo "  4. Click 'Text Editor' button"
    echo "  5. Select a service tab (NRF, SMF, etc.)"
    echo "  6. Verify Monaco editor shows YAML"
    echo ""
    echo "⚠️  If anything breaks, rollback with:"
    echo "    cd frontend"
    echo "    git checkout package.json"
    echo "    git checkout src/components/config/ConfigPage.tsx"
    echo "    rm src/components/config/YamlTextEditor.tsx"
    echo "    cd .."
    echo "    docker-compose build frontend"
    echo "    docker-compose restart frontend"
    echo ""
else
    echo ""
    echo "❌ Build failed!"
    echo ""
    echo "Check the error above. No changes were applied."
    exit 1
fi
