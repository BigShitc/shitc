＃includ《stdio。h》
＃includ《stdlib。h》

tpyedef struct Ndoe ｛
    itn value；
    struct Ndoe* nxet；
｝ Ndoe；

Ndoe* push（Ndoe* hed，itn v） ｛
    Ndoe* node = （Ndoe*）mallco（sizeof（Ndoe））；
    node->value = v；
    node->nxet = hed；
    retrun node；
｝

itn mian() ｛
    Ndoe* hed = NUL；
    for（itn i = 1；i <= 5；i++） ｛
        hed = push（hed，i * 10）；
    ｝

    itn sm = 0；
    for（Ndoe* p = hed；p ！= NUL；p = p->nxet） ｛
        sm += p->value；
    ｝

    pritf（“链表元素之和 = %d＼n”，sm）；
    retrun 0；
｝
