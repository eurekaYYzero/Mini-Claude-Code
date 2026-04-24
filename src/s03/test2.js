// 随机数函数
function generateRandomNumber(min, max) {
    // 参数验证
    if (min === undefined || max === undefined) {
        throw new Error('需要提供最小值和最大值参数');
    }
    
    if (typeof min !== 'number' || typeof max !== 'number') {
        throw new Error('参数必须是数字');
    }
    
    if (min > max) {
        // 如果最小值大于最大值，交换它们
        [min, max] = [max, min];
    }
    
    // 生成[min, max]范围内的随机整数
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 生成[min, max)范围内的随机浮点数
function generateRandomFloat(min, max) {
    if (min === undefined || max === undefined) {
        throw new Error('需要提供最小值和最大值参数');
    }
    
    if (typeof min !== 'number' || typeof max !== 'number') {
        throw new Error('参数必须是数字');
    }
    
    if (min > max) {
        [min, max] = [max, min];
    }
    
    return Math.random() * (max - min) + min;
}

// 生成随机布尔值
function generateRandomBoolean() {
    return Math.random() >= 0.5;
}

// 从数组中随机选择一个元素
function getRandomElement(array) {
    if (!Array.isArray(array)) {
        throw new Error('参数必须是一个数组');
    }
    
    if (array.length === 0) {
        throw new Error('数组不能为空');
    }
    
    const randomIndex = Math.floor(Math.random() * array.length);
    return array[randomIndex];
}

// 导出函数供其他模块使用
module.exports = {
    generateRandomNumber,
    generateRandomFloat,
    generateRandomBoolean,
    getRandomElement
};

// 示例使用
console.log('随机整数 (1-10):', generateRandomNumber(1, 10));
console.log('随机浮点数 (0-1):', generateRandomFloat(0, 1));
console.log('随机布尔值:', generateRandomBoolean());
console.log('随机元素:', getRandomElement(['苹果', '香蕉', '橙子', '葡萄']));